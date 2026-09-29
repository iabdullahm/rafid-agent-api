export const MODES = ["company_basic", "company_reputation", "business_risk"] as const;
export type Mode = (typeof MODES)[number];
export type BillingMode = "development" | "production";
export const EVENTS: Record<Mode, string> = {
  company_basic: "company-basic",
  company_reputation: "company-reputation",
  business_risk: "business-risk"
};
export const MAX_COMPANIES = 100;

export interface CompanyInput {
  name?: string;
  domain?: string;
  registrationNumber?: string;
  country?: string;
  city?: string;
  website?: string;
  address?: string;
  [key: string]: unknown;
}

export interface ActorInput { mode?: Mode; company?: CompanyInput; companies?: CompanyInput[]; }
export interface BillingStatus {
  mode: BillingMode;
  charged: boolean;
  event: string;
}

export interface PublicEntityCandidate {
  legalName?: string;
  registrationNumber?: string | null;
  country?: string | null;
  city?: string | null;
  registry?: string;
  registrationStatus?: string;
  incorporationDate?: string | null;
  matchedOn?: string[];
  matchConfidence?: number;
}

export interface AmbiguousEntityResolution {
  status: "ambiguous";
  candidateCount: number;
  recommendedNextAction: "retry_with_registration_number";
  candidates: PublicEntityCandidate[];
}

export interface SafeError {
  code: string;
  message: string;
  resolution?: AmbiguousEntityResolution;
}

export interface ItemResult { success: boolean; mode: Mode; company: CompanyInput; billing?: BillingStatus; resolution?: AmbiguousEntityResolution; [key: string]: unknown; }
