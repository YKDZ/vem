export const productDisplayImageSpec = {
  width: 1200,
  height: 1600,
  aspectRatio: "3:4",
  label: "1200 x 1600 px (3:4)",
} as const;

export const productSquareCropSpec = {
  width: 1200,
  height: 1200,
  aspectRatio: "1:1",
  label: "1200 x 1200 px (1:1)",
  crop: "vertical-center",
} as const;
