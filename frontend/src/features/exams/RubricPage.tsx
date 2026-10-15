import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import { api, type Exam } from "../../services/api";
import {
  EmptyState,
  ErrorState,
  Loading,
  SectionTitle,
  StatusTag,
} from "../../components/ui";

const itemSchema = z.object({
  question_number: z.string().min(1),
  prompt: z.string().min(1),
  expected_answer: z.string().min(1),
  alternatives: z.string().optional(),
  criteria: z.string().optional(),
  max_marks: z.coerce.number().gt(0),
});
const schema = z.object({ items: z.array(itemSchema).min(1) });
type FormInput = z.input<typeof schema>;
type Form = z.output<typeof schema>;
type RubricResponse = {
  rubric: {
    id: string;
    version: number;
    is_locked: boolean;
    items: (Form["items"][number] & { id: string; alternatives: string[] })[];
  } | null;
  exam_max_marks: number;
};

export function RubricPage() {
  const client = useQueryClient();
  const [examId, setExamId] = useState("");
  const [notice, setNotice] = useState("");
  const exams = useQuery({
    queryKey: ["exams"],
    queryFn: () => api<Exam[]>("/exams"),
  });
  useEffect(() => {
    if (!examId && exams.data?.length) setExamId(exams.data[0].id);
  }, [examId, exams.data]);
  const rubric = useQuery({
    queryKey: ["rubric", examId],
    queryFn: () => api<RubricResponse>(`/exams/${examId}/rubric`),
    enabled: Boolean(examId),
  });
  const form = useForm<FormInput, unknown, Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      items: [
        {
          question_number: "1(a)",
          prompt: "",
          expected_answer: "",
          alternatives: "",
          criteria: "",
          max_marks: 1,
        },
      ],
    },
  });
  const fields = useFieldArray({ control: form.control, name: "items" });
  useEffect(() => {
    if (!examId || !rubric.data) return;
    const items = rubric.data.rubric?.items?.map((item) => ({
      question_number: item.question_number,
      prompt: item.prompt,
      expected_answer: item.expected_answer,
      alternatives: item.alternatives.join("\n"),
      criteria: item.criteria,
      max_marks: Number(item.max_marks),
    })) || [
      {
        question_number: "1(a)",
        prompt: "",
        expected_answer: "",
        alternatives: "",
        criteria: "",
        max_marks: rubric.data.exam_max_marks,
      },
    ];
    form.reset({ items });
  }, [examId, rubric.data, form]);
  const save = useMutation({
    mutationFn: (values: Form) =>
      api(`/exams/${examId}/rubric`, {
        method: "PUT",
        body: JSON.stringify({
          items: values.items.map((item) => ({
            ...item,
            alternatives: (item.alternatives || "")
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            criteria: item.criteria || "",
          })),
        }),
      }),
    onSuccess: async () => {
      setNotice(
        "Rubric saved. It will be versioned automatically once grading starts.",
      );
      await client.invalidateQueries({ queryKey: ["rubric", examId] });
    },
  });
  if (exams.isPending) return <Loading label="Loading marking schemes…" />;
  if (exams.isError || !exams.data)
    return (
      <ErrorState
        message={exams.error?.message || "Could not load exams."}
        onRetry={() => exams.refetch()}
      />
    );
  if (!exams.data.length)
    return (
      <section className="panel">
        <EmptyState
          title="Create an examination first"
          detail="A marking scheme belongs to one examination and must add up to its configured maximum marks."
          action={
            <a className="btn primary" href="/batches">
              Open exam batches
            </a>
          }
        />
      </section>
    );
  const exam = exams.data.find((item) => item.id === examId);
  const total = form
    .watch("items")
    .reduce((sum, item) => sum + (Number(item.max_marks) || 0), 0);
  return (
    <>
      <section className="panel pad">
        <SectionTitle
          eyebrow="TEACHER-DEFINED MARKING"
          title="Marking scheme"
          detail="Write the expected answer and partial-credit rules before any AI proposal is generated."
          action={
            exam && (
              <StatusTag
                tone={rubric.data?.rubric?.is_locked ? "amber" : "blue"}
              >
                {rubric.data?.rubric
                  ? `Version ${rubric.data.rubric.version}${rubric.data.rubric.is_locked ? " · locked" : ""}`
                  : "Not saved"}
              </StatusTag>
            )
          }
        />
        <label className="label" htmlFor="rubric-exam">
          Examination
        </label>
        <select
          className="field exam-select"
          id="rubric-exam"
          value={examId}
          onChange={(e) => {
            setExamId(e.target.value);
            setNotice("");
          }}
        >
          <option value="">Choose exam</option>
          {exams.data.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title} · {e.max_marks} marks
            </option>
          ))}
        </select>
        {rubric.isPending && <Loading label="Loading this exam's rubric…" />}
        {rubric.isError && (
          <ErrorState
            message={rubric.error.message}
            onRetry={() => rubric.refetch()}
          />
        )}
        {exam && !rubric.isPending && (
          <form
            onSubmit={form.handleSubmit((v) => {
              setNotice("");
              save.mutate(v);
            })}
            noValidate
          >
            <div className="rubric-summary">
              <div>
                <span className="muted small">Exam maximum</span>
                <b>{exam.max_marks} marks</b>
              </div>
              <div>
                <span className="muted small">Rubric total</span>
                <b
                  className={
                    Math.abs(total - exam.max_marks) < 0.001
                      ? "text-green"
                      : "text-amber"
                  }
                >
                  {total} marks
                </b>
              </div>
              <span className="muted small">
                Totals must match before saving
              </span>
            </div>
            {fields.fields.map((field, index) => (
              <article className="rubric-item panel" key={field.id}>
                <div className="rubric-item-head">
                  <div className="eyebrow">QUESTION {index + 1}</div>
                  <button
                    type="button"
                    className="icon-button remove-item"
                    onClick={() => fields.remove(index)}
                    aria-label={`Remove question ${index + 1}`}
                    disabled={fields.fields.length === 1}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="form-grid">
                  <div>
                    <label className="label">Question number / part</label>
                    <input
                      className="field"
                      placeholder="e.g. 1(a)"
                      {...form.register(`items.${index}.question_number`)}
                    />
                  </div>
                  <div>
                    <label className="label">Maximum marks</label>
                    <input
                      className="field"
                      type="number"
                      min="0.5"
                      step="0.5"
                      {...form.register(`items.${index}.max_marks`)}
                    />
                  </div>
                </div>
                <label className="label">Question prompt</label>
                <textarea
                  rows={2}
                  className="field"
                  {...form.register(`items.${index}.prompt`)}
                />
                <label className="label">Expected answer</label>
                <textarea
                  rows={2}
                  className="field"
                  {...form.register(`items.${index}.expected_answer`)}
                />
                <label className="label">
                  Acceptable alternatives{" "}
                  <span className="muted">(one per line)</span>
                </label>
                <textarea
                  rows={2}
                  className="field"
                  {...form.register(`items.${index}.alternatives`)}
                />
                <label className="label">
                  Criteria and partial-credit rules
                </label>
                <textarea
                  rows={3}
                  className="field"
                  placeholder="Specify the evidence required for each portion of the marks."
                  {...form.register(`items.${index}.criteria`)}
                />
              </article>
            ))}
            <div className="rubric-footer">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  fields.append({
                    question_number: `${fields.fields.length + 1}`,
                    prompt: "",
                    expected_answer: "",
                    alternatives: "",
                    criteria: "",
                    max_marks: 1,
                  })
                }
              >
                <Plus size={14} /> Add question
              </button>
              <button className="btn primary" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save marking scheme"}
              </button>
            </div>
            {save.isError && (
              <div className="alert alert-error" role="alert">
                {save.error.message}
              </div>
            )}
            {notice && save.isSuccess && (
              <div className="alert alert-success">{notice}</div>
            )}
          </form>
        )}
      </section>
    </>
  );
}
