export type AmazonPayTransaction = {
  paymentStatusTitle: unknown;
  paymentAmount: unknown;
  receiverUpiId: unknown;
  upiTransactionId: unknown;
};

export function extractAmazonPayTransaction(documentLike: Pick<Document, 'querySelector'>): AmazonPayTransaction {
  const element = documentLike.querySelector('#payui-transaction-receipt-id');
  if (!element) throw new Error('Transaction receipt element not found');
  const dataValue = element.getAttribute('data');
  if (!dataValue) throw new Error('Transaction receipt data not found');
  const data = JSON.parse(dataValue) as any;
  return {
    paymentStatusTitle: data.paymentStatusDetails?.status,
    paymentAmount: data.paymentStatusDetails?.paymentAmount,
    receiverUpiId: data.paymentEntityOfTypePaymentMethodEntity?.paymentMethodInstruments?.[0]?.unmaskedVpaId,
    upiTransactionId: data.identifierEntities?.[0]?.identifierValues?.[0]?.ctaTitle,
  };
}
