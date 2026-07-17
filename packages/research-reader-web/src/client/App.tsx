import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type {
  PaperAnnotation,
  PaperPassport,
  PaperReview,
  ReadingQuestion,
} from "@intelligent-agent-system/research-reader";

export function App() {
  const [csrf, setCsrf] = useState("");
  const [papers, setPapers] = useState<PaperPassport[]>([]);
  const [selected, setSelected] = useState<PaperPassport>();
  const [reviews, setReviews] = useState<PaperReview[]>([]);
  const [annotations, setAnnotations] = useState<PaperAnnotation[]>([]);
  const [error, setError] = useState("");
  const selectionSequence = useRef(0);

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    try {
      const session = await api<{ csrfToken: string }>("/api/session");
      setCsrf(session.csrfToken);
      const loaded = await api<PaperPassport[]>("/api/papers");
      setPapers(loaded);
      if (loaded[0]) await selectPaper(loaded[0], session.csrfToken);
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function selectPaper(paper: PaperPassport, token = csrf) {
    const sequence = ++selectionSequence.current;
    try {
      setSelected(paper);
      setReviews([]);
      setAnnotations([]);
      const [loadedReviews, loadedAnnotations] = await Promise.all([
        api<PaperReview[]>(`/api/papers/${paper.id}/reviews`),
        api<PaperAnnotation[]>(`/api/papers/${paper.id}/annotations`),
      ]);
      if (sequence !== selectionSequence.current) return;
      setReviews(loadedReviews);
      setAnnotations(loadedAnnotations);
      if (!token) setError("CSRF session is unavailable");
      else setError("");
    } catch (cause) {
      if (sequence === selectionSequence.current) {
        setError(message(cause));
      }
    }
  }

  async function addAnnotation(input: {
    page?: number;
    selectedQuote?: string;
    drawingDataUrl?: string;
    voiceTranscript?: string;
    note: string;
  }) {
    if (!selected) return;
    const paperId = selected.id;
    const sequence = selectionSequence.current;
    try {
      const annotation = await api<PaperAnnotation>(
        `/api/papers/${paperId}/annotations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-reader-csrf": csrf,
          },
          body: JSON.stringify(input),
        },
      );
      if (sequence !== selectionSequence.current) return;
      setAnnotations((items) => [...items, annotation]);
    } catch (cause) {
      if (sequence === selectionSequence.current) {
        setError(message(cause));
      }
      throw cause;
    }
  }

  async function ask(question: string): Promise<ReadingQuestion> {
    if (!selected) throw new Error("Select a paper first");
    return api<ReadingQuestion>(`/api/papers/${selected.id}/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reader-csrf": csrf,
      },
      body: JSON.stringify({ question }),
    });
  }

  async function enableLocalNotifications() {
    if (!("Notification" in window)) {
      setError("This browser does not support local notifications.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      new Notification("Research Reader", {
        body: `${papers.length} paper(s) are available locally.`,
      });
    } else {
      setError("Local notification permission was not granted.");
    }
  }

  return (
    <main className="app-shell">
      <aside className="paper-list">
        <h1>Research Reader</h1>
        <p>{papers.length} papers</p>
        {papers.map((paper) => (
          <button
            className={paper.id === selected?.id ? "selected" : ""}
            key={paper.id}
            onClick={() => void selectPaper(paper)}
          >
            <strong>{paper.metadata.title}</strong>
            <span>
              {paper.reading.status} ·{" "}
              {paper.triage?.recommendation ?? "untriaged"}
            </span>
          </button>
        ))}
      </aside>
      <section className="workspace">
        {error ? <div className="error">{error}</div> : null}
        {selected ? (
          <>
            <header>
              <h2>{selected.metadata.title}</h2>
              <p>
                {selected.metadata.authors?.join(", ") || "Unknown authors"} ·{" "}
                {selected.metadata.published ??
                  selected.metadata.year ??
                  "Unknown date"}
              </p>
              <button onClick={() => void enableLocalNotifications()}>
                Enable local notifications
              </button>
            </header>
            <div className="reader-grid">
              <DocumentViewer key={selected.id} paperId={selected.id} />
              <aside className="inspector">
                <ReviewPanel key={`review-${selected.id}`} reviews={reviews} />
                <QuestionPanel key={`question-${selected.id}`} ask={ask} />
                <AnnotationPanel
                  key={`annotation-${selected.id}`}
                  annotations={annotations}
                  addAnnotation={addAnnotation}
                />
              </aside>
            </div>
          </>
        ) : (
          <p>No papers are available.</p>
        )}
      </section>
    </main>
  );
}

function DocumentViewer({ paperId }: { paperId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
    return () => {
      void pdf?.destroy();
    };
  }, [paperId]);

  useEffect(() => {
    if (pdf) void renderPage(pdf, page, canvas.current);
  }, [pdf, page]);

  async function load() {
    setPdf(undefined);
    setText("");
    setPage(1);
    try {
      const pdfResponse = await fetch(`/api/papers/${paperId}/pdf`);
      if (pdfResponse.ok) {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        const document = await pdfjs.getDocument({
          data: await pdfResponse.arrayBuffer(),
        }).promise;
        setPdf(document);
        return;
      }
      const textResponse = await fetch(`/api/papers/${paperId}/text`);
      if (!textResponse.ok) throw new Error("No local full text is available");
      setText(await textResponse.text());
    } catch (cause) {
      setError(message(cause));
    }
  }

  return (
    <section className="document-viewer">
      {error ? <div className="error">{error}</div> : null}
      {pdf ? (
        <>
          <div className="page-controls">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              Page {page} / {pdf.numPages}
            </span>
            <button
              disabled={page >= pdf.numPages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
          <canvas ref={canvas} />
        </>
      ) : (
        <pre>{text || "Loading full text..."}</pre>
      )}
    </section>
  );
}

function ReviewPanel({ reviews }: { reviews: PaperReview[] }) {
  const review = reviews[0];
  if (!review)
    return (
      <section>
        <h3>Review</h3>
        <p>No review.</p>
      </section>
    );
  return (
    <section>
      <h3>Latest Review</h3>
      <p>
        {review.level} · quality{" "}
        {review.scientificQuality?.toFixed(1) ?? "unknown"} · evidence{" "}
        {review.evidenceConfidence.toFixed(2)}
      </p>
      <p>{review.recommendation}</p>
      {review.integrityIssues?.map((issue) => (
        <p
          className={`issue ${issue.severity}`}
          key={`${issue.type}-${issue.message}`}
        >
          {issue.severity}: {issue.message}
        </p>
      ))}
    </section>
  );
}

function QuestionPanel({
  ask,
}: {
  ask: (question: string) => Promise<ReadingQuestion>;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<ReadingQuestion>();
  return (
    <section>
      <h3>Ask this paper</h3>
      <textarea
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <button
        onClick={() =>
          void ask(question)
            .then(setAnswer)
            .catch((cause) =>
              setAnswer({ question, answer: message(cause), citations: [] }),
            )
        }
      >
        Ask
      </button>
      {answer ? (
        <div>
          <p>{answer.answer}</p>
          {answer.citations.map((citation) => (
            <blockquote key={`${citation.start}-${citation.end}`}>
              {citation.quote}
            </blockquote>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AnnotationPanel({
  annotations,
  addAnnotation,
}: {
  annotations: PaperAnnotation[];
  addAnnotation: (input: {
    page?: number;
    selectedQuote?: string;
    drawingDataUrl?: string;
    voiceTranscript?: string;
    note: string;
  }) => Promise<void>;
}) {
  const [page, setPage] = useState("");
  const [quote, setQuote] = useState("");
  const [note, setNote] = useState("");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const drawingCanvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  function draw(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const canvas = drawingCanvas.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const bounds = canvas.getBoundingClientRect();
    context.lineWidth = 2;
    context.lineCap = "round";
    context.strokeStyle = "#17202a";
    context.lineTo(event.clientX - bounds.left, event.clientY - bounds.top);
    context.stroke();
    context.beginPath();
    context.moveTo(event.clientX - bounds.left, event.clientY - bounds.top);
  }

  function startVoice() {
    const Constructor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Constructor) {
      setNote(
        (value) =>
          `${value}${value ? "\n" : ""}Voice recognition is unavailable in this browser.`,
      );
      return;
    }
    const recognition = new Constructor();
    recognition.lang = navigator.language;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      setVoiceTranscript(transcript);
      setNote((value) => `${value}${value ? "\n" : ""}${transcript}`);
    };
    recognition.start();
  }

  function clearDrawing() {
    const canvas = drawingCanvas.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }

  return (
    <section>
      <h3>Annotations</h3>
      {annotations.map((annotation) => (
        <article key={annotation.id}>
          <strong>{annotation.status}</strong>
          <p>{annotation.note}</p>
          {annotation.drawingDataUrl ? (
            <img
              className="annotation-drawing"
              src={annotation.drawingDataUrl}
              alt="Handwritten annotation"
            />
          ) : null}
          {annotation.voiceTranscript ? (
            <small>Voice: {annotation.voiceTranscript}</small>
          ) : null}
        </article>
      ))}
      <input
        placeholder="Page"
        value={page}
        onChange={(event) => setPage(event.target.value)}
      />
      <textarea
        placeholder="Exact selected quote"
        value={quote}
        onChange={(event) => setQuote(event.target.value)}
      />
      <textarea
        placeholder="Your note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <canvas
        className="drawing-pad"
        ref={drawingCanvas}
        width={280}
        height={120}
        onPointerDown={(event) => {
          drawing.current = true;
          draw(event);
        }}
        onPointerMove={draw}
        onPointerUp={() => {
          drawing.current = false;
          drawingCanvas.current?.getContext("2d")?.beginPath();
        }}
        onPointerLeave={() => {
          drawing.current = false;
        }}
      />
      <div>
        <button onClick={clearDrawing}>Clear handwriting</button>
        <button onClick={startVoice}>Record voice note</button>
      </div>
      <button
        onClick={() => {
          const drawingDataUrl = drawingCanvas.current?.toDataURL("image/png");
          void addAnnotation({
            ...(page ? { page: Number(page) } : {}),
            ...(quote ? { selectedQuote: quote } : {}),
            ...(drawingDataUrl &&
            drawingDataUrl !== emptyCanvasDataUrl(280, 120)
              ? { drawingDataUrl }
              : {}),
            ...(voiceTranscript ? { voiceTranscript } : {}),
            note: note || "Handwritten annotation",
          })
            .then(() => {
              setNote("");
              setQuote("");
              setVoiceTranscript("");
              clearDrawing();
            })
            .catch(() => undefined);
        }}
      >
        Add annotation
      </button>
    </section>
  );
}

function emptyCanvasDataUrl(width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.toDataURL("image/png");
}

async function renderPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement | null,
) {
  if (!canvas) return;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.35 });
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas context is unavailable");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvas, canvasContext: context, viewport }).promise;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    throw new Error(
      typeof value === "object" && value && "error" in value
        ? value.error || `HTTP ${response.status}`
        : `HTTP ${response.status}`,
    );
  }
  return value as T;
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
