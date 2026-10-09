import { z } from "zod";

const resumeProjectSchema = z.object({
  name: z.string(),
  businessChallenge: z.string().optional().default(""),
  assignedResponsibility: z.string().optional().default(""),
  action: z.string().optional().default(""),
  result: z.string().optional().default(""),
});

const resumeExperienceSchema = z.object({
  company: z.string().min(1, "experience.company is required"),
  role: z.string().min(1, "experience.role is required"),
  dates: z.string().min(1, "experience.dates is required"),
  location: z.string().optional(),
  bullets: z.array(z.string()).default([]),
  projects: z.array(resumeProjectSchema).optional().default([]),
});

const generatedResumeContentSchema = z.object({
  title: z.string().trim().min(1, "content.title is required"),
  summary: z.string().trim().min(1, "content.summary is required"),
  skills: z.string().trim().min(1, "content.skills is required"),
  layout: z.enum(["bullets", "projects"]).optional(),
  fileName: z.string().trim().optional(),
  experiences: z
    .array(resumeExperienceSchema)
    .min(1, "content.experiences must include at least one experience"),
});

export const resumeRenderSchema = z
  .object({
    templateId: z.string().trim().min(1).optional(),
    templateBase64: z.string().trim().min(1).optional(),
    templateFileName: z.string().trim().optional(),
    content: generatedResumeContentSchema,
    jobTitle: z.string().trim().min(1, "jobTitle is required"),
    companyName: z.string().trim().min(1, "companyName is required"),
    jobDescription: z.string().optional().default(""),
    customPrompt: z.string().optional(),
    resumeFileBaseName: z.string().trim().optional(),
    profileName: z.string().trim().optional(),
    /** Existing archive id for re-apply / re-render. */
    resumeId: z.string().trim().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.templateId && !value.templateBase64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "templateId or templateBase64 is required",
        path: ["templateId"],
      });
    }
  });

export type ResumeRenderInput = z.infer<typeof resumeRenderSchema>;
