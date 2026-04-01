import {
  showToast,
  Toast,
  getSelectedFinderItems,
  showHUD,
  Clipboard,
  confirmAlert,
  Alert,
  Form,
  ActionPanel,
  Action,
  open,
  List,
  Icon,
  Detail,
  Keyboard,
} from "@raycast/api";
import { useState, useEffect } from "react";
import * as fs from "fs";
import * as path from "path";
import { exec, execSync } from "child_process";

// ============================================================================
// Constants — absolute paths because Raycast's PATH excludes Homebrew
// ============================================================================

const BREW_PREFIX = (() => {
  // Apple Silicon default; fall back to Intel
  if (fs.existsSync("/opt/homebrew/bin/brew")) return "/opt/homebrew";
  if (fs.existsSync("/usr/local/bin/brew")) return "/usr/local";
  return "/opt/homebrew"; // Assume Apple Silicon if brew itself isn't found yet
})();

const OCRMYPDF_PATH = `${BREW_PREFIX}/bin/ocrmypdf`;
const TESSERACT_PATH = `${BREW_PREFIX}/bin/tesseract`;

// ============================================================================
// Types
// ============================================================================

interface OcrOptions {
  redoOcr: boolean;
  language: string;
}

type DependencyStatus = "checking" | "ok" | "missing_ocrmypdf" | "missing_tesseract" | "missing_both";

interface DepCheckResult {
  status: DependencyStatus;
  hasOcrmypdf: boolean;
  hasTesseract: boolean;
}

// ============================================================================
// Dependency Checking
// ============================================================================

function checkDependencies(): DepCheckResult {
  const hasOcrmypdf = fs.existsSync(OCRMYPDF_PATH);
  const hasTesseract = fs.existsSync(TESSERACT_PATH);

  let status: DependencyStatus;
  if (hasOcrmypdf && hasTesseract) {
    status = "ok";
  } else if (!hasOcrmypdf && !hasTesseract) {
    status = "missing_both";
  } else if (!hasOcrmypdf) {
    status = "missing_ocrmypdf";
  } else {
    status = "missing_tesseract";
  }

  return { status, hasOcrmypdf, hasTesseract };
}

function getBrewVersion(): string {
  try {
    return execSync(`${BREW_PREFIX}/bin/brew --version`, { encoding: "utf-8", timeout: 5000 }).split("\n")[0];
  } catch {
    return "";
  }
}

function isHomebrewInstalled(): boolean {
  return fs.existsSync(`${BREW_PREFIX}/bin/brew`);
}

// ============================================================================
// Setup / Error Screen
// ============================================================================

function SetupScreen({ depResult, onRetry }: { depResult: DepCheckResult; onRetry: () => void }) {
  const hasBrew = isHomebrewInstalled();
  const brewVersion = hasBrew ? getBrewVersion() : "";

  const missingList: string[] = [];
  let installCmd = "";

  if (!depResult.hasOcrmypdf && !depResult.hasTesseract) {
    missingList.push("`ocrmypdf`", "`tesseract`");
    installCmd = "brew install ocrmypdf tesseract";
  } else if (!depResult.hasOcrmypdf) {
    missingList.push("`ocrmypdf`");
    installCmd = "brew install ocrmypdf";
  } else {
    missingList.push("`tesseract`");
    installCmd = "brew install tesseract";
  }

  const missingStr = missingList.join(" and ");

  let markdown = `# ⚠️ Setup Required\n\nThe **OCR PDF** command needs ${missingStr} to work.\n\n`;

  if (!hasBrew) {
    markdown += `## Step 1 — Install Homebrew\n\nHomebrew is a package manager for macOS that makes installing tools like \`ocrmypdf\` easy.\n\nOpen **Terminal** and paste:\n\`\`\`\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\`\`\`\n\n## Step 2 — Install ${missingStr}\n\nAfter Homebrew is installed, run:\n\`\`\`\n${installCmd}\n\`\`\`\n`;
  } else {
    markdown += `## Homebrew ✅\n\n${brewVersion} is already installed.\n\n## Install ${missingStr}\n\nOpen **Terminal** (press \`⌘ Space\`, type "Terminal") and run:\n\`\`\`\n${installCmd}\n\`\`\`\n\nThis may take a few minutes. Once done, come back to Raycast and press **"Check Again"**.\n\n---\n\n`;
  }

  markdown += `### Why these tools?\n- **ocrmypdf** — Adds an invisible text layer to scanned PDFs, making them searchable and copyable.\n- **tesseract** — The open-source OCR engine that \`ocrmypdf\` uses under the hood.\n`;

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action
            title="Check Again"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={onRetry}
          />
          <Action.CopyToClipboard
            title="Copy Install Command"
            content={installCmd}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
          {hasBrew && (
            <Action.OpenInBrowser
              title="Open Terminal"
              url="file:///System/Applications/Utilities/Terminal.app"
            />
          )}
        </ActionPanel>
      }
    />
  );
}

// ============================================================================
// OCR Logic
// ============================================================================

function ocrPdf(filePath: string, options: OcrOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const flags: string[] = [];

    if (options.redoOcr) {
      flags.push("--redo-ocr");
    } else {
      flags.push("--skip-text");
    }

    if (options.language && options.language.trim()) {
      flags.push(`-l "${options.language.trim()}"`);
    }

    // Same path for input and output = in-place replacement
    const cmd = `"${OCRMYPDF_PATH}" ${flags.join(" ")} "${filePath}" "${filePath}"`;
    console.log("[DEBUG] Running:", cmd);

    // ocrmypdf spawns tesseract as a subprocess. Raycast's PATH omits Homebrew,
    // so we inject BREW_PREFIX/bin into the child process environment explicitly.
    const env = {
      ...process.env,
      PATH: `${BREW_PREFIX}/bin:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
    };

    exec(cmd, { timeout: 600000 /* 10 min */, env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}


async function getPdfFromClipboard(): Promise<string | null> {
  try {
    const { text, file } = await Clipboard.read();

    if (file) {
      const filePath = file.startsWith("file://") ? decodeURIComponent(file.replace("file://", "")) : file;
      if (filePath.toLowerCase().endsWith(".pdf") && fs.existsSync(filePath)) {
        return filePath;
      }
    }

    if (text) {
      const trimmed = text.trim();
      const decoded = trimmed.startsWith("file://") ? decodeURIComponent(trimmed.replace("file://", "")) : trimmed;
      if (decoded.toLowerCase().endsWith(".pdf") && fs.existsSync(decoded)) {
        return decoded;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/** Returns true if the raw error string indicates a tesseract-not-found problem. */
function isTesseractMissingError(raw: string): boolean {
  return (
    raw.includes("tesseract") &&
    (raw.includes("not found") ||
      raw.includes("could not be executed") ||
      raw.includes("FileNotFoundError") ||
      raw.includes("No such file or directory"))
  );
}

/**
 * Map a raw ocrmypdf error to a short human-friendly string.
 * Tesseract-missing errors are handled separately (they trigger the setup screen).
 */
function friendlyOcrError(raw: string): string {
  if (raw.includes("PriorOcrFoundError") || raw.includes("already has text") || raw.toLowerCase().includes("exit code 6")) {
    return "Already has text layer (enable 'Re-do OCR' to overwrite)";
  }
  if (raw.includes("EncryptedPdfError") || raw.includes("encrypted")) {
    return "PDF is password-protected and cannot be OCR'd";
  }
  if (raw.includes("No such file") || raw.includes("not found")) {
    return "File not found — was it moved or deleted?";
  }
  if (raw.includes("timed out") || raw.includes("timeout")) {
    return "Timed out — the PDF may be very large";
  }
  // Strip verbose INFO/DEBUG lines from ocrmypdf's stderr
  const firstLine = raw.split("\n").find((l) => l.trim() && !l.startsWith("INFO") && !l.startsWith("DEBUG"));
  return firstLine?.trim() ?? raw.slice(0, 200);
}

// ============================================================================
// Main Command
// ============================================================================

export default function Command() {
  const [depResult, setDepResult] = useState<DepCheckResult>({ status: "checking", hasOcrmypdf: false, hasTesseract: false });
  // Used to show setup screen when a dep error surfaces at runtime
  const showSetupScreen = depResult.status !== "checking" && depResult.status !== "ok";
  const [isLoading, setIsLoading] = useState(true);
  const [pdfPaths, setPdfPaths] = useState<string[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [redoOcr, setRedoOcr] = useState(false);
  const [language, setLanguage] = useState("eng");
  const [source, setSource] = useState<"finder" | "clipboard" | "picker">("finder");

  function runDepCheck() {
    const result = checkDependencies();
    setDepResult(result);
    return result;
  }

  // On mount: check deps, then detect PDF source
  useEffect(() => {
    async function initialize() {
      const deps = runDepCheck();
      if (deps.status !== "ok") {
        setIsLoading(false);
        return;
      }

      await detectPdfSource();
    }

    initialize();
  }, []);

  async function detectPdfSource() {
    setIsLoading(true);

    try {
      const finderItems = await getSelectedFinderItems();
      const pdfs = finderItems
        .filter((item) => item.path.toLowerCase().endsWith(".pdf"))
        .map((item) => item.path);

      if (pdfs.length > 0) {
        setPdfPaths(pdfs);
        setSource("finder");
        setIsLoading(false);
        return;
      }
    } catch {
      // Finder not focused
    }

    const clipboardPdf = await getPdfFromClipboard();
    if (clipboardPdf) {
      setPdfPaths([clipboardPdf]);
      setSource("clipboard");
      setIsLoading(false);
      return;
    }

    setShowFilePicker(true);
    setIsLoading(false);
  }

  async function runOcr() {
    // Re-verify deps right before running (user may have just installed them)
    const deps = checkDependencies();
    if (deps.status !== "ok") {
      setDepResult(deps);
      return;
    }

    if (pdfPaths.length === 0) {
      await showToast({ style: Toast.Style.Failure, title: "No PDFs selected" });
      return;
    }

    const confirmed = await confirmAlert({
      title: `OCR ${pdfPaths.length === 1 ? "1 PDF" : `${pdfPaths.length} PDFs`}`,
      message:
        `This will OCR and replace the original ${pdfPaths.length === 1 ? "file" : "files"} in-place:\n\n` +
        pdfPaths.map((p) => `• ${path.basename(p)}`).join("\n") +
        `\n\nThe originals will be overwritten with searchable versions. Continue?`,
      primaryAction: { title: "OCR & Replace", style: Alert.ActionStyle.Default },
    });

    if (!confirmed) return;

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "OCR in progress…",
      message: `0 / ${pdfPaths.length} files`,
    });

    const options: OcrOptions = { redoOcr, language };
    let succeeded = 0;
    let skipped = 0;
    const failures: { name: string; reason: string }[] = [];
    let tesseractMissing = false;

    for (let i = 0; i < pdfPaths.length; i++) {
      const filePath = pdfPaths[i];
      const basename = path.basename(filePath);
      toast.message = `${i + 1} / ${pdfPaths.length}: ${basename}`;

      try {
        await ocrPdf(filePath, options);
        succeeded++;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);

        if (
          raw.includes("PriorOcrFoundError") ||
          raw.includes("already has text") ||
          raw.toLowerCase().includes("exit code 6")
        ) {
          // Already searchable — skip, not a hard failure
          skipped++;
          console.log(`[DEBUG] Skipped (already OCR'd): ${basename}`);
        } else if (isTesseractMissingError(raw)) {
          // Tesseract isn't reachable — bail and show the setup screen
          tesseractMissing = true;
          console.error(`[DEBUG] Tesseract missing at runtime:`, raw);
          break;
        } else {
          failures.push({ name: basename, reason: friendlyOcrError(raw) });
          console.error(`[DEBUG] OCR failed for ${basename}:`, raw);
        }
      }
    }

    // If tesseract vanished at runtime, swap to the setup/install screen
    if (tesseractMissing) {
      toast.hide();
      setDepResult({ status: "missing_tesseract", hasOcrmypdf: true, hasTesseract: false });
      return;
    }

    const parts: string[] = [];
    if (succeeded > 0) parts.push(`✓ ${succeeded} OCR'd`);
    if (skipped > 0) parts.push(`⊘ ${skipped} already searchable`);
    if (failures.length > 0) parts.push(`✗ ${failures.length} failed`);

    if (failures.length > 0) {
      toast.style = Toast.Style.Failure;
      toast.title = failures.length === 1 ? `Failed: ${failures[0].name}` : `${failures.length} files failed`;
      toast.message = failures[0].reason + (failures.length > 1 ? ` (+${failures.length - 1} more)` : "");
    } else {
      toast.style = Toast.Style.Success;
      toast.title = "OCR Complete";
      toast.message = parts.join("  •  ");
      if (pdfPaths.length > 0) await open(path.dirname(pdfPaths[0]));
      await showHUD(`✓ ${parts.join("  •  ")}`);
    }
  }

  // ── Dependency check failed → show setup screen ─────────────────────────

  if (showSetupScreen) {
    return (
      <SetupScreen
        depResult={depResult}
        onRetry={() => {
          const fresh = runDepCheck();
          if (fresh.status === "ok") {
            detectPdfSource();
          }
        }}
      />
    );
  }

  // ── File picker fallback ─────────────────────────────────────────────────

  if (showFilePicker) {
    return (
      <FilePickerForm
        redoOcr={redoOcr}
        language={language}
        onRedoOcrChange={setRedoOcr}
        onLanguageChange={setLanguage}
        onSubmit={(selectedPaths) => {
          setPdfPaths(selectedPaths);
          setSource("picker");
          setShowFilePicker(false);
        }}
      />
    );
  }

  // ── Confirmation / run form ──────────────────────────────────────────────

  if (!isLoading && pdfPaths.length > 0) {
    const sourceLabel =
      source === "finder" ? "📂 Selected in Finder" : source === "clipboard" ? "📋 From Clipboard" : "📁 Manually selected";

    return (
      <Form
        isLoading={isLoading}
        actions={
          <ActionPanel>
            <Action title="OCR & Replace File(s)" icon={Icon.TextDocument} onAction={runOcr} />
            <Action
              title="Choose Different File(s)"
              icon={Icon.Folder}
              shortcut={{ modifiers: ["cmd"], key: "o" }}
              onAction={() => setShowFilePicker(true)}
            />
          </ActionPanel>
        }
      >
        <Form.Description title="Source" text={sourceLabel} />
        <Form.Description
          title={`PDF${pdfPaths.length > 1 ? "s" : ""} to OCR (${pdfPaths.length})`}
          text={pdfPaths.map((p) => `${path.basename(p)}\n${p}`).join("\n\n")}
        />
        <Form.Separator />
        <Form.Checkbox
          id="redoOcr"
          label="Re-do OCR (replace existing text layer)"
          value={redoOcr}
          onChange={setRedoOcr}
          info="Enable this if the PDF already has a text layer but it's wrong or you want to regenerate it. By default, already-searchable PDFs are skipped."
        />
        <Form.TextField
          id="language"
          title="Language(s)"
          placeholder="eng"
          value={language}
          onChange={setLanguage}
          info="Tesseract language codes. Common: eng (English), fra (French), deu (German), spa (Spanish), chi_sim (Simplified Chinese). Combine with +, e.g. 'eng+fra'."
        />
      </Form>
    );
  }

  // ── Loading / detecting state ────────────────────────────────────────────

  return (
    <List isLoading={true} navigationTitle="OCR PDF">
      <List.EmptyView title="Detecting PDF…" icon={Icon.Document} />
    </List>
  );
}

// ============================================================================
// File Picker Form
// ============================================================================

function FilePickerForm({
  redoOcr,
  language,
  onRedoOcrChange,
  onLanguageChange,
  onSubmit,
}: {
  redoOcr: boolean;
  language: string;
  onRedoOcrChange: (v: boolean) => void;
  onLanguageChange: (v: string) => void;
  onSubmit: (paths: string[]) => void;
}) {
  const [filePaths, setFilePaths] = useState<string[]>([]);

  function handleSubmit() {
    const pdfs = filePaths.filter((p) => p.toLowerCase().endsWith(".pdf"));
    if (pdfs.length === 0) {
      showToast({
        style: Toast.Style.Failure,
        title: "No PDFs selected",
        message: "Please select one or more PDF files",
      });
      return;
    }
    onSubmit(pdfs);
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Continue" onSubmit={handleSubmit} icon={Icon.ArrowRight} />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="pdfs"
        title="Select PDF(s)"
        allowMultipleSelection={true}
        canChooseDirectories={false}
        value={filePaths}
        onChange={setFilePaths}
        info="Select one or more PDF files to OCR. You can also select a PDF in Finder before launching this command."
      />
      <Form.Separator />
      <Form.Checkbox
        id="redoOcr"
        label="Re-do OCR (replace existing text layer)"
        value={redoOcr}
        onChange={onRedoOcrChange}
        info="Enable this if the PDF already has a text layer but it's wrong or you want to regenerate it."
      />
      <Form.TextField
        id="language"
        title="Language(s)"
        placeholder="eng"
        value={language}
        onChange={onLanguageChange}
        info="Tesseract language codes. Common: eng, fra, deu, spa, chi_sim. Combine with +, e.g. 'eng+fra'."
      />
    </Form>
  );
}
