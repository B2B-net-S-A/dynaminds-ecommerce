import { useEffect, useRef, useState } from 'react';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import './print-label-pdf-preview.css';

export type PrintLabelPdfReady = {
  previewId: string;
  contentSha256: string;
  ready: boolean;
  pageCount: number;
  viewedPages: number;
};
export type PrintLabelPdfPreviewProps = {
  contextKey: string;
  previewId: string;
  contentSha256: string;
  /** The parent has already verified every byte and its SHA-256 against the frozen preview. */
  data: Uint8Array;
  maxBytes?: number;
  maxPages?: number;
  onReady: (result: PrintLabelPdfReady) => void;
};
const MAX_PIXELS = 4000000;
type Loaded = { pdf: PDFDocumentProxy; identity: string; data: Uint8Array };

export function PrintLabelPdfPreview(props: PrintLabelPdfPreviewProps) {
  const maxBytes = props.maxBytes ?? 2097152;
  const maxPages = props.maxPages;
  const identity = `${props.contextKey}:${props.previewId}:${props.contentSha256}:${maxBytes}:${maxPages ?? ''}`;
  const scope = useRef(identity);
  scope.current = identity;
  const latestData = useRef(props.data);
  latestData.current = props.data;
  const callback = useRef(props.onReady);
  callback.current = props.onReady;
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const documentToken = useRef(0),
    renderToken = useRef(0);
  const activeRender = useRef<RenderTask | null>(null),
    renderFence = useRef<Promise<void>>(Promise.resolve());
  const visited = useRef(new Set<number>());
  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [page, setPage] = useState(1);
  const [rendered, setRendered] = useState<{
    identity: string;
    data: Uint8Array;
    page: number;
  } | null>(null);
  const [error, setError] = useState(''),
    [viewedPages, setViewedPages] = useState(0);
  const validDocument = loaded?.identity === identity && loaded.data === props.data ? loaded : null;
  const shown =
    !!validDocument &&
    rendered?.identity === identity &&
    rendered.data === props.data &&
    rendered.page === page;

  function notify(ready: boolean, pageCount = 0, count = 0) {
    callback.current({
      previewId: props.previewId,
      contentSha256: props.contentSha256,
      ready,
      pageCount,
      viewedPages: count,
    });
  }
  useEffect(() => {
    const token = ++documentToken.current,
      data = props.data,
      id = identity;
    let closed = false,
      task: PDFDocumentLoadingTask | null = null;
    const current = () =>
      !closed &&
      documentToken.current === token &&
      scope.current === id &&
      latestData.current === data;
    setLoaded(null);
    setRendered(null);
    setError('');
    setPage(1);
    setViewedPages(0);
    visited.current = new Set();
    notify(false);
    void (async () => {
      try {
        if (
          !data.byteLength ||
          !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16777216 ||
          (maxPages !== undefined && (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 500)) ||
          data.byteLength > maxBytes ||
          !/^[a-f0-9]{64}$/.test(props.contentSha256)
        )
          throw Error('Niepełny zweryfikowany plik PDF.');
        const [pdfjs, worker] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]);
        if (!current()) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        // A copy is transferred to PDF.js: the parent's verified original remains intact.
        // No script/annotation layer, URLs, credentials, XFA, or external asset location is supplied.
        const init = {
          data: data.slice(),
          enableXfa: false,
          stopAtErrors: true,
          useWorkerFetch: false,
          useWasm: false,
          canvasMaxAreaInBytes: MAX_PIXELS * 4,
        };
        task = pdfjs.getDocument(init);
        const pdf = await task.promise;
        if (!current()) return;
        if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || (maxPages !== undefined && pdf.numPages > maxPages))
          throw Error('PDF nie zawiera poprawnej liczby stron.');
        setLoaded({ pdf, identity: id, data });
      } catch {
        if (current()) {
          setError(
            'Nie udało się otworzyć całego PDF. Odczytaj plik ponownie; bez poprawnego podglądu zgoda na kolejkę pozostaje zablokowana.',
          );
          notify(false);
        }
      }
    })();
    return () => {
      closed = true;
      documentToken.current++;
      renderToken.current++;
      activeRender.current?.cancel();
      if (canvas.current) {
        canvas.current.width = 1;
        canvas.current.height = 1;
      }
      void task?.destroy().catch(() => {});
    };
  }, [identity, props.data]);

  useEffect(() => {
    if (!validDocument) return;
    const doc = validDocument,
      token = ++renderToken.current,
      id = identity,
      data = props.data;
    let closed = false,
      task: RenderTask | null = null,
      pdfPage: PDFPageProxy | null = null;
    const current = () =>
      !closed &&
      renderToken.current === token &&
      scope.current === id &&
      latestData.current === data;
    setRendered(null);
    setError('');
    notify(false, doc.pdf.numPages, visited.current.size);
    void (async () => {
      try {
        await renderFence.current;
        if (!current()) return;
        pdfPage = await doc.pdf.getPage(page);
        if (!current()) return;
        const target = canvas.current,
          viewport1 = pdfPage.getViewport({ scale: 1 });
        if (
          !target ||
          !target.getContext('2d') ||
          !Number.isFinite(viewport1.width) ||
          !Number.isFinite(viewport1.height) ||
          viewport1.width <= 0 ||
          viewport1.height <= 0
        )
          throw Error('Nieprawidłowy zakres strony PDF.');
        const cssWidth = Math.min(1000, Math.max(240, (host.current?.clientWidth ?? 800) - 24));
        const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const scale = Math.min(
          (cssWidth * ratio) / viewport1.width,
          Math.sqrt(MAX_PIXELS / (viewport1.width * viewport1.height)),
          4096 / viewport1.width,
          4096 / viewport1.height,
        );
        const viewport = pdfPage.getViewport({ scale });
        const width = Math.floor(viewport.width),
          height = Math.floor(viewport.height);
        if (
          !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          width < 1 ||
          height < 1 ||
          width * height > MAX_PIXELS
        )
          throw Error('Nie można bezpiecznie wyrenderować tej strony.');
        target.width = width;
        target.height = height;
        target.style.width = `${width / ratio}px`;
        target.style.height = 'auto';
        task = pdfPage.render({
          canvas: target,
          viewport,
          annotationMode: 0,
          background: 'rgb(255,255,255)',
        });
        activeRender.current = task;
        renderFence.current = task.promise.then(
          () => {},
          () => {},
        );
        await task.promise;
        if (!current()) return;
        visited.current.add(page);
        setViewedPages(visited.current.size);
        setRendered({ identity: id, data, page });
        notify(visited.current.size === doc.pdf.numPages, doc.pdf.numPages, visited.current.size);
      } catch {
        if (current()) {
          setRendered(null);
          setError(
            `Nie udało się wyświetlić strony ${page}. Nie potwierdzono pełnego podglądu PDF; odczytaj plik ponownie.`,
          );
          notify(false, doc.pdf.numPages, visited.current.size);
        }
      } finally {
        if (activeRender.current === task) activeRender.current = null;
        pdfPage?.cleanup();
      }
    })();
    return () => {
      closed = true;
      renderToken.current++;
      task?.cancel();
      if (canvas.current) {
        canvas.current.width = 1;
        canvas.current.height = 1;
      }
    };
  }, [validDocument, page, identity, props.data]);

  function changePage(next: number) {
    if (!validDocument || !shown || next < 1 || next > validDocument.pdf.numPages) return;
    notify(false, validDocument.pdf.numPages, visited.current.size);
    setRendered(null);
    setPage(next);
  }
  return (
    <div className="print-label-pdf-preview" aria-label="Pełny podgląd PDF etykiety">
      <div className="plp-controls">
        <button
          className="button"
          disabled={!shown || page <= 1}
          onClick={() => changePage(page - 1)}
        >
          Poprzednia strona PDF
        </button>
        <span aria-live="polite">
          {validDocument ? `Strona ${page} z ${validDocument.pdf.numPages}` : 'Otwieranie PDF…'}
        </span>
        <button
          className="button"
          disabled={!shown || !validDocument || page >= validDocument.pdf.numPages}
          onClick={() => changePage(page + 1)}
        >
          Następna strona PDF
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        !shown && <p role="status">Renderowanie strony PDF…</p>
      )}
      <div className="plp-page" ref={host}>
        <canvas
          ref={canvas}
          hidden={!shown}
          role="img"
          aria-label={`Etykieta PDF — strona ${page}`}
        />
      </div>
      {shown && (
        <p aria-live="polite">
          Wyrenderowano {viewedPages} z {validDocument?.pdf.numPages} stron.{' '}
          {viewedPages === validDocument?.pdf.numPages
            ? 'Sprawdź treść przed osobną zgodą na kolejkę.'
            : 'Przejdź przez wszystkie strony, aby udostępnić zgodę na kolejkę.'}
        </p>
      )}
    </div>
  );
}
