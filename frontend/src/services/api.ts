export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function csrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = document.cookie
    .split("; ")
    .find((part) => part.startsWith("gradeflow_csrf="))
    ?.split("=")
    .slice(1)
    .join("=");
  return value ? decodeURIComponent(value) : undefined;
}

function apiPath(path: string): string {
  return path.startsWith("/api/v1") ? path : `/api/v1${path}`;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const method = (options.method || "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(apiPath(path), {
    ...options,
    headers,
    credentials: "include",
  });
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const error = typeof body === "object" && body?.error;
    throw new ApiError(
      error?.message || `Request failed (${response.status})`,
      response.status,
      error?.code,
    );
  }
  return body as T;
}

export function apiUpload<T>(
  path: string,
  formData: FormData,
  onProgress: (percentage: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", apiPath(path));
    request.withCredentials = true;
    request.timeout = 300_000;
    const csrf = csrfToken();
    if (csrf) request.setRequestHeader("X-CSRF-Token", csrf);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0)
        onProgress(
          Math.min(99, Math.round((event.loaded / event.total) * 100)),
        );
    });
    request.addEventListener("error", () =>
      reject(
        new ApiError(
          "Upload connection failed. Check the network and try again.",
          0,
        ),
      ),
    );
    request.addEventListener("timeout", () =>
      reject(
        new ApiError(
          "Upload timed out. Retry with fewer or smaller scan files.",
          0,
        ),
      ),
    );
    request.addEventListener("load", () => {
      const type = request.getResponseHeader("content-type") || "";
      let body: unknown;
      try {
        body = type.includes("application/json")
          ? JSON.parse(request.responseText)
          : request.responseText;
      } catch {
        reject(
          new ApiError(
            "The server returned an unreadable upload response.",
            request.status,
          ),
        );
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        const error =
          typeof body === "object" && body !== null && "error" in body
            ? (body as { error?: { message?: string; code?: string } }).error
            : undefined;
        reject(
          new ApiError(
            error?.message || `Upload failed (${request.status})`,
            request.status,
            error?.code,
          ),
        );
        return;
      }
      onProgress(100);
      resolve(body as T);
    });
    request.send(formData);
  });
}

export type Me = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  organization_id: string;
  organization_name: string;
};
export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};
export type Student = {
  id: string;
  admission_number: string;
  first_name: string;
  last_name: string;
  is_active: boolean;
  class_name?: string | null;
};
export type AcademicItem = {
  id: string;
  name?: string;
  label?: string;
  academic_year_id?: string;
  code?: string | null;
  is_current?: boolean;
};
export type Exam = {
  id: string;
  title: string;
  class_id: string;
  subject_id: string;
  academic_year_id: string;
  term_id: string;
  exam_type: string;
  max_marks: number;
  scheduled_on?: string | null;
  status: string;
  created_at: string;
};
export type ExamDetails = Exam & {
  updated_at: string;
  papers: {
    id: string;
    file_name: string;
    student_id: string | null;
    status: string;
    created_at: string;
  }[];
};
export type Paper = {
  id: string;
  exam_id: string;
  upload_batch_id?: string | null;
  student_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: number;
  status: string;
  created_at: string;
};
export type UploadBatch = {
  id: string;
  exam_id: string;
  status: string;
  total_files: number;
  accepted_files: number;
  rejected_files: number;
  errors: {
    file_name: string;
    message: string;
    status: number;
    code?: string;
  }[];
  created_at: string;
};
export type ProcessingJob = {
  id: string;
  paper_id: string;
  task_type: string;
  status: string;
  progress: number;
  error_message?: string | null;
  attempts: number;
  created_at: string;
};
export type UnorganizedPage = {
  id: string;
  paper_id: string;
  source_paper_id: string | null;
  source_page_number: number;
  rendered_page_number: number;
  page_number: number;
  rotation: number;
  flagged: boolean;
  file_name: string;
};
