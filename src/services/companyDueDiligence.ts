import { previewCompanyDueDiligence, runCompanyDueDiligence } from "../company-due-diligence/service.js";

export const companyDueDiligence = (input: unknown) => runCompanyDueDiligence(input);
export const previewCompanyDueDiligenceCapability = (input: unknown) => previewCompanyDueDiligence(input);
