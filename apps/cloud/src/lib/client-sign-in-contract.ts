import { z } from "zod";

export const clientSignInDecisionSchema = z.strictObject({
  approve: z.boolean(),
  shared: z.boolean(),
});

export interface ClientSignInConsent {
  id: string;
  clientName: string;
  organization: string;
  account: string;
  canShare: boolean;
}
