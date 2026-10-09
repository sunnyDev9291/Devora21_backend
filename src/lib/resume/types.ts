export type ResumeProject = {
  name: string;
  businessChallenge: string;
  assignedResponsibility: string;
  action: string;
  result: string;
};

export type ResumeTemplateLayout = "bullets" | "projects";

export type ResumeExperience = {
  company: string;
  role: string;
  dates: string;
  /** Optional workplace / city line. */
  location?: string;
  bullets: string[];
  projects?: ResumeProject[];
};

export type ResumeEducation = {
  degree?: string;
  university?: string;
  period?: string;
};

export type GeneratedResumeContent = {
  title: string;
  summary: string;
  skills: string;
  fileName?: string;
  layout?: ResumeTemplateLayout;
  experiences: ResumeExperience[];
  education?: ResumeEducation;
};

/** Profile / personal fields filled into styled templates (not taken from template text). */
export type ResumeFillProfile = {
  name?: string;
  title?: string;
  country?: string;
  phone?: string;
  email?: string;
  linkedin?: string;
  education?: ResumeEducation;
};

export type TemplateJobSkeleton = {
  company: string;
  role: string;
  dates: string;
  bulletCount: number;
  projectNames: string[];
  /** Paragraph indices within document.xml paragraph list */
  startParaIndex: number;
  endParaIndex: number; // exclusive
  companyParaIndex: number;
  roleParaIndex: number;
  datesParaIndex: number;
  /** Joao-style workplace line under the job header (e.g. "City | Remote"). Not a bullet. */
  locationParaIndex?: number;
  bulletParaIndices: number[];
  /** Plain text of each template bullet slot (same order as bulletParaIndices). */
  bulletSamples: string[];
  projectBlocks: Array<{
    name: string;
    nameParaIndex: number;
    fieldParaIndices: {
      businessChallenge?: number;
      assignedResponsibility?: number;
      action?: number;
      result?: number;
    };
  }>;
};

export type StyleSlotIndex = {
  name?: number;
  title?: number;
  country?: number;
  phone?: number;
  email?: number;
  linkedin?: number;
  /** Body paragraphs with style=summary (usually one). */
  summaryBodyIndices: number[];
  /** Alternating skillcat / skillitem pairs in body. */
  skillCatIndices: number[];
  skillItemIndices: number[];
  degree?: number;
  universityName?: number;
  universityPeriod?: number;
};

export type HeaderStyleSlots = {
  /** Path inside DOCX zip, e.g. word/header1.xml */
  partPath: string;
  xml: string;
  paragraphs: string[];
  nameIndex?: number;
  titleIndex?: number;
};

export type ParsedResumeTemplate = {
  /** Style-based templates only (legacy text-header mode removed). */
  mode: "styled";
  layout: ResumeTemplateLayout;
  profileName: string;
  headerTitle: string;
  skillsSample: string;
  jobs: TemplateJobSkeleton[];
  summaryHeaderIndex: number;
  skillsHeaderIndex: number;
  experienceHeaderIndex: number;
  educationHeaderIndex: number | null;
  paragraphs: string[];
  documentXml: string;
  styleSlots: StyleSlotIndex;
  headerParts?: HeaderStyleSlots[];
};
