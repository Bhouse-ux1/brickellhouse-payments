export const DEFAULT_GL_CODE = "40090" as const;
export const VALET_GL_CODE = "40033" as const;
export const VALET_PRODUCT_ID = "valet_parking" as const;

export function trustedGlCodeForProduct(productId: string): string {
  return productId === VALET_PRODUCT_ID ? VALET_GL_CODE : DEFAULT_GL_CODE;
}

export function trustedGlCodeForCustomCharge(): typeof DEFAULT_GL_CODE {
  return DEFAULT_GL_CODE;
}
