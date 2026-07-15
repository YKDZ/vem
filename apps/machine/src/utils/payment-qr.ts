import * as QRCode from "qrcode";

export async function renderPaymentQrDataUrl(value: string): Promise<string> {
  const svg = await QRCode.toString(value, {
    type: "svg",
    width: 360,
    margin: 1,
    errorCorrectionLevel: "M",
    color: {
      dark: "#020617",
      light: "#ffffff",
    },
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
