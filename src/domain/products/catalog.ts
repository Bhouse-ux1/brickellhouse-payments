import { trustedGlCodeForProduct } from "@/domain/accounting/gl-rules";

export type TrustedProduct = {
  id: string;
  displayName: string;
  priceCents: number;
  glCode: string;
  active: boolean;
  terminalEnabled: boolean;
  quantityAllowed: boolean;
  category: "Access" | "Keys" | "Maintenance" | "Printing" | "Valet";
};

export const productCatalog: readonly TrustedProduct[] = [
  { id: "parking_fob", displayName: "Parking Fob", priceCents: 5500, glCode: trustedGlCodeForProduct("parking_fob"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Access" },
  { id: "elevator_fob", displayName: "Elevator Fob", priceCents: 5500, glCode: trustedGlCodeForProduct("elevator_fob"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Access" },
  { id: "mailbox_key_copy", displayName: "Mailbox Key Copy", priceCents: 1000, glCode: trustedGlCodeForProduct("mailbox_key_copy"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Keys" },
  { id: "unit_key_copy", displayName: "Unit Key Copy", priceCents: 2500, glCode: trustedGlCodeForProduct("unit_key_copy"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Keys" },
  { id: "smoke_detector_battery", displayName: "Smoke Detector Battery Replacement", priceCents: 1000, glCode: trustedGlCodeForProduct("smoke_detector_battery"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Maintenance" },
  { id: "ac_filter_replacement", displayName: "AC Filter Replacement", priceCents: 2000, glCode: trustedGlCodeForProduct("ac_filter_replacement"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Maintenance" },
  { id: "unclogged_service", displayName: "Toilet or Sink Unclogged Service", priceCents: 3000, glCode: trustedGlCodeForProduct("unclogged_service"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Maintenance" },
  { id: "thermostat_check", displayName: "Thermostat Reset or System Check", priceCents: 2500, glCode: trustedGlCodeForProduct("thermostat_check"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Maintenance" },
  { id: "smoke_alarm_replacement", displayName: "Smoke Alarm Replacement", priceCents: 5500, glCode: trustedGlCodeForProduct("smoke_alarm_replacement"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Maintenance" },
  { id: "black_white_printing", displayName: "Black & White Printing", priceCents: 10, glCode: trustedGlCodeForProduct("black_white_printing"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Printing" },
  { id: "color_printing", displayName: "Color Printing", priceCents: 25, glCode: trustedGlCodeForProduct("color_printing"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Printing" },
  { id: "valet_parking", displayName: "Valet Parking", priceCents: 25000, glCode: trustedGlCodeForProduct("valet_parking"), active: true, terminalEnabled: true, quantityAllowed: true, category: "Valet" },
] as const;
