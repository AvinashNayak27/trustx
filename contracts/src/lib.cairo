use starknet::ContractAddress;

// ABI-compatible with privacy::objects::OpenNoteDeposit. Keeping the small
// value type local lets this standalone package compile without pulling the
// complete privacy monorepo workspace into the starter kit.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

#[starknet::interface]
pub trait IErc20<TState> {
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
}

/// Entry stored per private UPI listing.
#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub struct UpiDepositEntry {
    pub token: ContractAddress,
    pub amount: u128,
    /// INR per whole token, encoded with 18 decimals.
    pub price_per_token_inr: u128,
    pub upi_id: felt252,
    pub recover_address: ContractAddress,
    pub settled: bool,
    pub withdrawn: bool,
    pub intent_expires_at: u64,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum UpiEscrowOperation {
    Deposit,
    Settle,
    SignalIntent,
}

#[starknet::interface]
pub trait IUpiEscrow<T> {
    fn get_deposit(self: @T, deposit_id: u64) -> UpiDepositEntry;
    fn get_next_deposit_id(self: @T) -> u64;
    fn get_signer_public_key(self: @T) -> felt252;
    fn get_privacy_contract(self: @T) -> ContractAddress;
    fn get_intent_fee_token(self: @T) -> ContractAddress;
    fn get_intent_fee_collector(self: @T) -> ContractAddress;
    fn get_accrued_intent_fees(self: @T) -> u128;

    /// Return an unfilled listing to its explicitly configured recovery wallet.
    fn withdraw(ref self: T, deposit_id: u64);

    /// Transfers the accrued intent fees to the configured deployer/collector.
    fn withdraw_intent_fees(ref self: T);

    /// Called only by the privacy pool. Unused fields are zero for Deposit and SignalIntent.
    fn privacy_invoke(
        ref self: T,
        operation: UpiEscrowOperation,
        deposit_id: felt252,
        token: ContractAddress,
        amount: u128,
        upi_id: felt252,
        price_per_token_inr: u128,
        recover_address: ContractAddress,
        signature_r: felt252,
        signature_s: felt252,
        payment_status_title: felt252,
        payment_total_amount_low: u128,
        payment_total_amount_high: u128,
        receiver_upi_id: felt252,
        upi_transaction_id: felt252,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
}

/// The local TEE normalizes Amazon Pay's successful statuses to this
/// case-sensitive canonical felt before hashing and signing.
pub const UPI_PAYMENT_SUCCESS: felt252 = 0x53756363657373;
pub const UPI_INTENT_WINDOW_SECONDS: u64 = 1800;
/// One whole STRK (18 decimals), paid to the escrow before signalling intent.
pub const UPI_INTENT_FEE: u128 = 1_000_000_000_000_000_000;
pub const UPI_DECIMALS: u256 = 1000000000000000000;
/// The extension reduces its final Pedersen value modulo 2^251 before signing.
pub const STARK_MESSAGE_BOUND: u256 = u256 {
    low: 0, high: 10633823966279326983230456482242756608,
};

pub mod upi_errors {
    pub const ZERO_PRIVACY_CONTRACT: felt252 = 'ZERO_PRIVACY';
    pub const ZERO_SIGNER: felt252 = 'ZERO_SIGNER';
    pub const ZERO_FEE_TOKEN: felt252 = 'ZERO_FEE_TOKEN';
    pub const ZERO_FEE_COLLECTOR: felt252 = 'ZERO_FEE_COLLECTOR';
    pub const ZERO_TOKEN: felt252 = 'ZERO_TOKEN';
    pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
    pub const ZERO_PRICE: felt252 = 'ZERO_PRICE';
    pub const ZERO_UPI_ID: felt252 = 'ZERO_UPI_ID';
    pub const ZERO_RECOVER_ADDRESS: felt252 = 'ZERO_RECOVER';
    pub const DEPOSIT_NOT_FOUND: felt252 = 'DEPOSIT_NOT_FOUND';
    pub const ALREADY_SETTLED: felt252 = 'ALREADY_SETTLED';
    pub const ALREADY_WITHDRAWN: felt252 = 'ALREADY_WITHDRAWN';
    pub const ACTIVE_INTENT: felt252 = 'ACTIVE_INTENT';
    pub const INTENT_REQUIRED: felt252 = 'INTENT_REQUIRED';
    pub const CALLER_NOT_PRIVACY: felt252 = 'CALLER_NOT_PRIVACY';
    pub const CALLER_NOT_RECOVERY: felt252 = 'CALLER_NOT_RECOVERY';
    pub const CALLER_NOT_FEE_COLLECTOR: felt252 = 'CALLER_NOT_FEE_COLLECTOR';
    pub const FIELD_MISMATCH: felt252 = 'FIELD_MISMATCH';
    pub const INVALID_SIGNATURE: felt252 = 'INVALID_SIGNATURE';
    pub const PAYMENT_NOT_SUCCESS: felt252 = 'PAYMENT_NOT_SUCCESS';
    pub const UPI_TXN_USED: felt252 = 'UPI_TXN_USED';
    pub const UPI_ID_MISMATCH: felt252 = 'UPI_ID_MISMATCH';
    pub const INSUFFICIENT_PAYMENT: felt252 = 'INSUFFICIENT_PAY';
    pub const TOKEN_TRANSFER_FAILED: felt252 = 'TOKEN_TRANSFER_FAIL';
    pub const INCORRECT_INTENT_FEE: felt252 = 'INCORRECT_INTENT_FEE';
}

/// Pedersen chain used by the TEE signer in `extention/apps/tee-server`.
pub fn compute_upi_payment_hash(
    payment_status_title: felt252,
    payment_total_amount: u256,
    receiver_upi_id: felt252,
    upi_transaction_id: felt252,
) -> felt252 {
    let amount_low: felt252 = payment_total_amount.low.into();
    let amount_high: felt252 = payment_total_amount.high.into();
    let h0 = core::pedersen::pedersen(0, payment_status_title);
    let h1 = core::pedersen::pedersen(h0, amount_low);
    let h2 = core::pedersen::pedersen(h1, amount_high);
    let h3 = core::pedersen::pedersen(h2, receiver_upi_id);
    let h4 = core::pedersen::pedersen(h3, upi_transaction_id);
    let h5 = core::pedersen::pedersen(h4, 5);
    let as_u256: u256 = h5.into();
    (as_u256 % STARK_MESSAGE_BOUND).try_into().expect('PAYMENT_HASH_RANGE')
}

#[starknet::contract]
pub mod UpiEscrow {
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::Zero;
    use starknet::storage::{
        StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use super::{
        IErc20Dispatcher, IErc20DispatcherTrait, IUpiEscrow, OpenNoteDeposit,
        UPI_DECIMALS, UPI_INTENT_FEE, UPI_INTENT_WINDOW_SECONDS, UPI_PAYMENT_SUCCESS, UpiDepositEntry,
        UpiEscrowOperation, compute_upi_payment_hash, upi_errors,
    };

    #[storage]
    struct Storage {
        privacy_contract: ContractAddress,
        signer_public_key: felt252,
        intent_fee_token: ContractAddress,
        intent_fee_collector: ContractAddress,
        next_deposit_id: u64,
        accrued_intent_fees: u128,
        deposits: starknet::storage::Map<u64, UpiDepositEntry>,
        nullifiers: starknet::storage::Map<felt252, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        DepositCreated: DepositCreated,
        IntentSignaled: IntentSignaled,
        DepositSettled: DepositSettled,
        DepositWithdrawn: DepositWithdrawn,
    }

    #[derive(Drop, starknet::Event)]
    struct DepositCreated {
        #[key]
        deposit_id: u64,
        token: ContractAddress,
        amount: u128,
        upi_id: felt252,
        price_per_token_inr: u128,
        recover_address: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct IntentSignaled {
        #[key]
        deposit_id: u64,
        intent_expires_at: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct DepositSettled {
        #[key]
        deposit_id: u64,
        upi_transaction_id: felt252,
        note_id: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct DepositWithdrawn {
        #[key]
        deposit_id: u64,
        recover_address: ContractAddress,
        amount: u128,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        privacy_contract: ContractAddress,
        signer_public_key: felt252,
        intent_fee_token: ContractAddress,
        intent_fee_collector: ContractAddress,
    ) {
        assert(privacy_contract.is_non_zero(), upi_errors::ZERO_PRIVACY_CONTRACT);
        assert(signer_public_key.is_non_zero(), upi_errors::ZERO_SIGNER);
        assert(intent_fee_token.is_non_zero(), upi_errors::ZERO_FEE_TOKEN);
        assert(intent_fee_collector.is_non_zero(), upi_errors::ZERO_FEE_COLLECTOR);
        self.privacy_contract.write(privacy_contract);
        self.signer_public_key.write(signer_public_key);
        self.intent_fee_token.write(intent_fee_token);
        self.intent_fee_collector.write(intent_fee_collector);
        self.next_deposit_id.write(1);
    }

    #[abi(embed_v0)]
    pub impl UpiEscrowImpl of IUpiEscrow<ContractState> {
        fn get_deposit(self: @ContractState, deposit_id: u64) -> UpiDepositEntry {
            self.deposits.read(deposit_id)
        }

        fn get_next_deposit_id(self: @ContractState) -> u64 {
            self.next_deposit_id.read()
        }

        fn get_signer_public_key(self: @ContractState) -> felt252 {
            self.signer_public_key.read()
        }

        fn get_privacy_contract(self: @ContractState) -> ContractAddress {
            self.privacy_contract.read()
        }

        fn get_intent_fee_token(self: @ContractState) -> ContractAddress {
            self.intent_fee_token.read()
        }

        fn get_intent_fee_collector(self: @ContractState) -> ContractAddress {
            self.intent_fee_collector.read()
        }

        fn get_accrued_intent_fees(self: @ContractState) -> u128 {
            self.accrued_intent_fees.read()
        }

        fn withdraw(ref self: ContractState, deposit_id: u64) {
            let entry = self.deposits.read(deposit_id);
            assert(entry.token.is_non_zero(), upi_errors::DEPOSIT_NOT_FOUND);
            assert(!entry.settled, upi_errors::ALREADY_SETTLED);
            assert(!entry.withdrawn, upi_errors::ALREADY_WITHDRAWN);
            assert(get_caller_address() == entry.recover_address, upi_errors::CALLER_NOT_RECOVERY);
            assert(get_block_timestamp() >= entry.intent_expires_at, upi_errors::ACTIVE_INTENT);

            self.deposits.write(deposit_id, UpiDepositEntry { withdrawn: true, ..entry });
            let transferred = IErc20Dispatcher { contract_address: entry.token }
                .transfer(recipient: entry.recover_address, amount: entry.amount.into());
            assert(transferred, upi_errors::TOKEN_TRANSFER_FAILED);
            self.emit(DepositWithdrawn {
                deposit_id, recover_address: entry.recover_address, amount: entry.amount,
            });
        }

        fn withdraw_intent_fees(ref self: ContractState) {
            assert(
                get_caller_address() == self.intent_fee_collector.read(),
                upi_errors::CALLER_NOT_FEE_COLLECTOR,
            );
            let fees = self.accrued_intent_fees.read();
            self.accrued_intent_fees.write(0);
            if fees.is_non_zero() {
                let transferred = IErc20Dispatcher { contract_address: self.intent_fee_token.read() }
                    .transfer(recipient: self.intent_fee_collector.read(), amount: fees.into());
                assert(transferred, upi_errors::TOKEN_TRANSFER_FAILED);
            }
        }

        fn privacy_invoke(
            ref self: ContractState,
            operation: UpiEscrowOperation,
            deposit_id: felt252,
            token: ContractAddress,
            amount: u128,
            upi_id: felt252,
            price_per_token_inr: u128,
            recover_address: ContractAddress,
            signature_r: felt252,
            signature_s: felt252,
            payment_status_title: felt252,
            payment_total_amount_low: u128,
            payment_total_amount_high: u128,
            receiver_upi_id: felt252,
            upi_transaction_id: felt252,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let privacy_addr = self.privacy_contract.read();
            assert(get_caller_address() == privacy_addr, upi_errors::CALLER_NOT_PRIVACY);

            match operation {
                UpiEscrowOperation::Deposit => {
                    assert(token.is_non_zero(), upi_errors::ZERO_TOKEN);
                    assert(amount.is_non_zero(), upi_errors::ZERO_AMOUNT);
                    assert(upi_id.is_non_zero(), upi_errors::ZERO_UPI_ID);
                    assert(price_per_token_inr.is_non_zero(), upi_errors::ZERO_PRICE);
                    assert(recover_address.is_non_zero(), upi_errors::ZERO_RECOVER_ADDRESS);

                    let next_id = self.next_deposit_id.read();
                    self.next_deposit_id.write(next_id + 1);
                    self.deposits.write(
                        next_id,
                        UpiDepositEntry {
                            token,
                            amount,
                            price_per_token_inr,
                            upi_id,
                            recover_address,
                            settled: false,
                            withdrawn: false,
                            intent_expires_at: 0,
                        },
                    );
                    self.emit(DepositCreated {
                        deposit_id: next_id,
                        token,
                        amount,
                        upi_id,
                        price_per_token_inr,
                        recover_address,
                    });
                    [].span()
                },
                UpiEscrowOperation::SignalIntent => {
                    let id: u64 = deposit_id.try_into().expect(upi_errors::FIELD_MISMATCH);
                    let entry = self.deposits.read(id);
                    assert(entry.token.is_non_zero(), upi_errors::DEPOSIT_NOT_FOUND);
                    assert(!entry.settled, upi_errors::ALREADY_SETTLED);
                    assert(!entry.withdrawn, upi_errors::ALREADY_WITHDRAWN);
                    assert(token == self.intent_fee_token.read(), upi_errors::INCORRECT_INTENT_FEE);
                    assert(amount == UPI_INTENT_FEE, upi_errors::INCORRECT_INTENT_FEE);
                    let now = get_block_timestamp();
                    assert(now >= entry.intent_expires_at, upi_errors::ACTIVE_INTENT);
                    let expires_at = now + UPI_INTENT_WINDOW_SECONDS;
                    self.deposits.write(
                        id, UpiDepositEntry { intent_expires_at: expires_at, ..entry },
                    );
                    self.accrued_intent_fees.write(
                        self.accrued_intent_fees.read() + UPI_INTENT_FEE,
                    );
                    self.emit(IntentSignaled { deposit_id: id, intent_expires_at: expires_at });
                    [].span()
                },
                UpiEscrowOperation::Settle => {
                    let id: u64 = deposit_id.try_into().expect(upi_errors::FIELD_MISMATCH);
                    let entry = self.deposits.read(id);
                    assert(entry.token.is_non_zero(), upi_errors::DEPOSIT_NOT_FOUND);
                    assert(!entry.settled, upi_errors::ALREADY_SETTLED);
                    assert(!entry.withdrawn, upi_errors::ALREADY_WITHDRAWN);
                    assert(
                        entry.intent_expires_at > get_block_timestamp(),
                        upi_errors::INTENT_REQUIRED,
                    );
                    assert(entry.token == token, upi_errors::FIELD_MISMATCH);
                    assert(entry.amount == amount, upi_errors::FIELD_MISMATCH);
                    assert(entry.upi_id == upi_id, upi_errors::FIELD_MISMATCH);
                    assert(signature_r.is_non_zero(), upi_errors::INVALID_SIGNATURE);
                    assert(signature_s.is_non_zero(), upi_errors::INVALID_SIGNATURE);

                    let payment_total: u256 = u256 {
                        low: payment_total_amount_low, high: payment_total_amount_high,
                    };
                    let message_hash = compute_upi_payment_hash(
                        payment_status_title,
                        payment_total,
                        receiver_upi_id,
                        upi_transaction_id,
                    );
                    let signature_valid = check_ecdsa_signature(
                        message_hash, self.signer_public_key.read(), signature_r, signature_s,
                    );
                    assert(signature_valid, upi_errors::INVALID_SIGNATURE);
                    assert(payment_status_title == UPI_PAYMENT_SUCCESS, upi_errors::PAYMENT_NOT_SUCCESS);
                    assert(receiver_upi_id == entry.upi_id, upi_errors::UPI_ID_MISMATCH);
                    assert(!self.nullifiers.read(upi_transaction_id), upi_errors::UPI_TXN_USED);

                    let required_payment =
                        (Into::<u128, u256>::into(entry.amount)
                            * Into::<u128, u256>::into(entry.price_per_token_inr))
                            / UPI_DECIMALS;
                    assert(payment_total >= required_payment, upi_errors::INSUFFICIENT_PAYMENT);

                    self.nullifiers.write(upi_transaction_id, true);
                    self.deposits.write(id, UpiDepositEntry { settled: true, ..entry });
                    self.emit(DepositSettled { deposit_id: id, upi_transaction_id, note_id });

                    IErc20Dispatcher { contract_address: entry.token }
                        .approve(spender: privacy_addr, amount: entry.amount.into());
                    [OpenNoteDeposit { note_id, token: entry.token, amount: entry.amount }].span()
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use core::ecdsa::check_ecdsa_signature;
    use snforge_std::{
        DeclareResultTrait, declare, start_cheat_block_timestamp_global,
        start_cheat_caller_address, start_mock_call,
    };
    use starknet::deployment::DeploymentParams;
    use starknet::ContractAddress;
    use super::{
        IUpiEscrowDispatcher, IUpiEscrowDispatcherTrait, UPI_INTENT_FEE, UPI_INTENT_WINDOW_SECONDS,
        UPI_PAYMENT_SUCCESS, UpiEscrow, UpiEscrowOperation, compute_upi_payment_hash,
    };

    const PRIVACY: felt252 = 'PRIVACY_POOL';
    const RECOVERY: felt252 = 'RECOVERY';
    const TOKEN: felt252 = 0x1234;
    const SIGNER: felt252 = 0x5678;

    fn deploy_upi_escrow() -> (ContractAddress, IUpiEscrowDispatcher) {
        let privacy: ContractAddress = PRIVACY.try_into().unwrap();
        let class = declare("UpiEscrow").unwrap().contract_class();
        let params = DeploymentParams { salt: 0, deploy_from_zero: true };
        let (address, _) = UpiEscrow::deploy_for_test(
            class_hash: *class.class_hash,
            deployment_params: params,
            privacy_contract: privacy,
            signer_public_key: SIGNER,
            intent_fee_token: TOKEN.try_into().unwrap(),
            intent_fee_collector: RECOVERY.try_into().unwrap(),
        )
            .unwrap();
        (address, IUpiEscrowDispatcher { contract_address: address })
    }

    fn deposit(dispatcher: IUpiEscrowDispatcher, address: ContractAddress) {
        start_cheat_caller_address(address, PRIVACY.try_into().unwrap());
        dispatcher
            .privacy_invoke(
                operation: UpiEscrowOperation::Deposit,
                deposit_id: 0,
                token: TOKEN.try_into().unwrap(),
                amount: 1_000_000_000_000_000_000,
                upi_id: 'alice@upi',
                price_per_token_inr: 100_000_000_000_000_000_000,
                recover_address: RECOVERY.try_into().unwrap(),
                signature_r: 0,
                signature_s: 0,
                payment_status_title: 0,
                payment_total_amount_low: 0,
                payment_total_amount_high: 0,
                receiver_upi_id: 0,
                upi_transaction_id: 0,
                note_id: 0,
            );
    }

    fn signal_intent(
        dispatcher: IUpiEscrowDispatcher, address: ContractAddress, timestamp: u64,
    ) {
        start_cheat_block_timestamp_global(timestamp);
        start_cheat_caller_address(address, PRIVACY.try_into().unwrap());
        dispatcher
            .privacy_invoke(
                operation: UpiEscrowOperation::SignalIntent,
                deposit_id: 1,
                token: TOKEN.try_into().unwrap(),
                amount: UPI_INTENT_FEE,
                upi_id: 0,
                price_per_token_inr: 0,
                recover_address: 0.try_into().unwrap(),
                signature_r: 0,
                signature_s: 0,
                payment_status_title: 0,
                payment_total_amount_low: 0,
                payment_total_amount_high: 0,
                receiver_upi_id: 0,
                upi_transaction_id: 0,
                note_id: 0,
            );
    }

    #[test]
    fn deposit_records_recovery_and_scaled_price() {
        let (address, dispatcher) = deploy_upi_escrow();
        deposit(dispatcher, address);
        let entry = dispatcher.get_deposit(1);
        assert(entry.amount == 1_000_000_000_000_000_000, 'BAD_AMOUNT');
        assert(entry.price_per_token_inr == 100_000_000_000_000_000_000, 'BAD_PRICE');
        assert(entry.upi_id == 'alice@upi', 'BAD_UPI');
        assert(entry.recover_address == RECOVERY.try_into().unwrap(), 'BAD_RECOVERY');
        assert(dispatcher.get_next_deposit_id() == 2, 'BAD_NEXT_ID');
    }

    #[test]
    fn signal_intent_sets_exact_non_renewable_window() {
        let (address, dispatcher) = deploy_upi_escrow();
        deposit(dispatcher, address);
        signal_intent(dispatcher, address, 10_000);
        assert(
            dispatcher.get_deposit(1).intent_expires_at == 10_000 + UPI_INTENT_WINDOW_SECONDS,
            'BAD_INTENT_EXPIRY',
        );
        assert(dispatcher.get_accrued_intent_fees() == UPI_INTENT_FEE, 'BAD_INTENT_FEE');
    }

    #[test]
    fn fee_collector_can_withdraw_accrued_intent_fees() {
        let (address, dispatcher) = deploy_upi_escrow();
        deposit(dispatcher, address);
        signal_intent(dispatcher, address, 10_000);
        start_cheat_caller_address(address, RECOVERY.try_into().unwrap());
        start_mock_call(TOKEN.try_into().unwrap(), selector!("transfer"), true);
        dispatcher.withdraw_intent_fees();
        assert(dispatcher.get_accrued_intent_fees() == 0, 'FEES_NOT_WITHDRAWN');
    }

    #[test]
    #[should_panic(expected: 'ACTIVE_INTENT')]
    fn active_intent_cannot_be_renewed() {
        let (address, dispatcher) = deploy_upi_escrow();
        deposit(dispatcher, address);
        signal_intent(dispatcher, address, 10_000);
        signal_intent(dispatcher, address, 10_001);
    }

    #[test]
    #[should_panic(expected: 'ACTIVE_INTENT')]
    fn active_intent_blocks_recovery() {
        let (address, dispatcher) = deploy_upi_escrow();
        deposit(dispatcher, address);
        signal_intent(dispatcher, address, 10_000);
        start_cheat_caller_address(address, RECOVERY.try_into().unwrap());
        dispatcher.withdraw(1);
    }

    #[test]
    #[should_panic(expected: 'CALLER_NOT_RECOVERY')]
    fn only_recovery_wallet_can_withdraw() {
        let (address, dispatcher) = deploy_upi_escrow();
        deposit(dispatcher, address);
        start_cheat_caller_address(address, 'ATTACKER'.try_into().unwrap());
        dispatcher.withdraw(1);
    }

    #[test]
    fn recovery_succeeds_at_intent_expiry() {
        let (address, dispatcher) = deploy_upi_escrow();
        deposit(dispatcher, address);
        signal_intent(dispatcher, address, 10_000);
        start_cheat_block_timestamp_global(10_000 + UPI_INTENT_WINDOW_SECONDS);
        start_cheat_caller_address(address, RECOVERY.try_into().unwrap());
        start_mock_call(TOKEN.try_into().unwrap(), selector!("transfer"), true);
        dispatcher.withdraw(1);
        assert(dispatcher.get_deposit(1).withdrawn, 'NOT_WITHDRAWN');
    }

    #[test]
    #[should_panic(expected: 'INTENT_REQUIRED')]
    fn settlement_requires_active_intent() {
        let (address, dispatcher) = deploy_upi_escrow();
        deposit(dispatcher, address);
        start_cheat_caller_address(address, PRIVACY.try_into().unwrap());
        dispatcher
            .privacy_invoke(
                operation: UpiEscrowOperation::Settle,
                deposit_id: 1,
                token: TOKEN.try_into().unwrap(),
                amount: 1_000_000_000_000_000_000,
                upi_id: 'alice@upi',
                price_per_token_inr: 0,
                recover_address: 0.try_into().unwrap(),
                signature_r: 1,
                signature_s: 1,
                payment_status_title: UPI_PAYMENT_SUCCESS,
                payment_total_amount_low: 100_000_000_000_000_000_000,
                payment_total_amount_high: 0,
                receiver_upi_id: 'alice@upi',
                upi_transaction_id: '123456789',
                note_id: 1,
            );
    }

    #[test]
    fn payment_hash_is_deterministic_and_non_zero() {
        let hash = compute_upi_payment_hash(
            UPI_PAYMENT_SUCCESS,
            100_000_000_000_000_000_000,
            'alice@upi',
            '123456789',
        );
        assert(hash != 0, 'HASH_IS_ZERO');
        assert(
            hash == compute_upi_payment_hash(
                UPI_PAYMENT_SUCCESS,
                100_000_000_000_000_000_000,
                'alice@upi',
                '123456789',
            ),
            'HASH_CHANGED',
        );
        assert(
            hash == 0x01a8f3adee7251fcebc4751b49b0cf9d3aa8e2884d7de3364787e8a3f7c94c2a,
            'TEE_HASH_MISMATCH',
        );
        assert(
            check_ecdsa_signature(
                hash,
                0x3502be14209a50a57d8bd703a78b4484ffbe32974354d2bef82d4662a70b772,
                2619026873519495059509449949808649633935824233757195656309265051255271219709,
                1459764710950781816000012462241615504592928133317652682918109166690853570395,
            ),
            'TEE_SIGNATURE_MISMATCH',
        );
    }

    #[test]
    fn live_tee_receipt_signature_is_valid_for_escrow_signer() {
        let hash = compute_upi_payment_hash(
            0x53756363657373,
            200_000_000_000_000_000_000,
            0x67617263686f6d704061786c,
            0x363235303836373937373332,
        );
        assert(
            hash == 0x027173ecd19bd1d50ba2464e66a3e1efde9f2c74bbae27e87b318f4897d75714,
            'LIVE_TEE_HASH_MISMATCH',
        );
        assert(
            check_ecdsa_signature(
                hash,
                0x3502be14209a50a57d8bd703a78b4484ffbe32974354d2bef82d4662a70b772,
                3214614532388635294057365492556021814570721485968042608886592649132562615395,
                1267903756552109311897899101018625425619903303444740819592184847466588327691,
            ),
            'LIVE_TEE_SIGNATURE_MISMATCH',
        );
    }
}
