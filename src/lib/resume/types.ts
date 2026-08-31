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
  bullets: string[];
  projects?: ResumeProject[];
};

export type GeneratedResumeContent = {
  title: string;
  summary: string;
  skills: string;
  fileName?: string;
  layout?: ResumeTemplateLayout;
  experiences: ResumeExperience[];
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
  bulletParaIndices: number[];
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

export type ParsedResumeTemplate = {
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
};
