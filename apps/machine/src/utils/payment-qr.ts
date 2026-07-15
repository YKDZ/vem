import * as QRCode from "qrcode";

export async function renderPaymentQrDataUrl(value: string): Promise<string> {
  return QRCode.toDataURL(value, {
    width: 360,
    margin: 1,
    errorCorrectionLevel: "M",
    color: {
      dark: "#020617",
      light: "#ffffff",
    },
  });
}
