import {
  Form,
  ActionPanel,
  Action,
  showToast,
  Toast,
  getSelectedFinderItems,
  showHUD,
  Clipboard,
  open,
  popToRoot,
} from "@raycast/api";
import { useState, useEffect } from "react";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as libre from "libreoffice-convert";
import { promisify } from "util";

const convertAsync = promisify(libre.convert);

// Supported file extensions and their valid output formats
const SUPPORTED_FORMATS: Record<string, string[]> = {
  ".doc": [".pdf", ".docx", ".pdf+.docx"],
  ".docx": [".pdf", ".doc", ".pdf+.doc"],
};

const FORMAT_LABELS: Record<string, string> = {
  ".pdf": "PDF",
  ".doc": "Word Document (.doc)",
  ".docx": "Word Document (.docx)",
  ".pdf+.docx": "Both (PDF + DOCX)",
  ".pdf+.doc": "Both (PDF + DOC)",
};

/**
 * Check if LibreOffice is installed on the system
 */
function isLibreOfficeInstalled(): boolean {
  try {
    // Check common macOS LibreOffice paths
    execSync("which soffice || ls /Applications/LibreOffice.app 2>/dev/null", {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the file extension from a path
 */
function getExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

/**
 * Check if a file is a supported document type
 */
function isSupportedFile(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext in SUPPORTED_FORMATS;
}

/**
 * Get available output formats for a given input file
 */
function getOutputFormats(filePath: string): string[] {
  const ext = getExtension(filePath);
  return SUPPORTED_FORMATS[ext] || [];
}

/**
 * Convert a document to the specified format
 */
async function convertDocument(inputPath: string, outputFormat: string): Promise<string> {
  const inputBuffer = fs.readFileSync(inputPath);
  const outputBuffer = await convertAsync(inputBuffer, outputFormat, undefined);

  // Create output path by replacing extension
  const outputPath = inputPath.replace(/\.[^.]+$/, outputFormat);
  fs.writeFileSync(outputPath, outputBuffer);

  return outputPath;
}

/**
 * Convert a document to multiple formats
 */
async function convertDocumentMultiple(inputPath: string, formats: string[]): Promise<string[]> {
  const outputPaths: string[] = [];
  for (const format of formats) {
    const outputPath = await convertDocument(inputPath, format);
    outputPaths.push(outputPath);
  }
  return outputPaths;
}

/**
 * Copy files to clipboard (macOS only)
 */
async function copyFilesToClipboard(filePaths: string[]): Promise<void> {
  // Use AppleScript to copy files to clipboard as file references
  const pathList = filePaths.map((p) => `POSIX file "${p}"`).join(", ");
  const script = `set the clipboard to {${pathList}}`;
  execSync(`osascript -e '${script}'`);
}

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [useFilePicker, setUseFilePicker] = useState(false);
  const [outputFormat, setOutputFormat] = useState<string>("");
  const [isConverting, setIsConverting] = useState(false);

  // Check LibreOffice installation and try to get Finder selection on mount
  useEffect(() => {
    async function initialize() {
      // Check if LibreOffice is installed
      if (!isLibreOfficeInstalled()) {
        await showToast({
          style: Toast.Style.Failure,
          title: "LibreOffice Required",
          message: "Install with: brew install --cask libreoffice",
          primaryAction: {
            title: "Copy Install Command",
            onAction: async () => {
              await Clipboard.copy("brew install --cask libreoffice");
              await showHUD("Command copied to clipboard!");
            },
          },
          secondaryAction: {
            title: "Open Homebrew",
            onAction: () => open("https://brew.sh"),
          },
        });
        await popToRoot();
        return;
      }

      // Try to get selected file from Finder
      try {
        const finderItems = await getSelectedFinderItems();
        const supportedFiles = finderItems.filter((item) => isSupportedFile(item.path));

        if (supportedFiles.length > 0) {
          const filePath = supportedFiles[0].path;
          setSelectedFile(filePath);
          // Set default output format
          const formats = getOutputFormats(filePath);
          if (formats.length > 0) {
            setOutputFormat(formats[0]);
          }
        } else {
          // No valid file selected in Finder, show file picker
          setUseFilePicker(true);
        }
      } catch {
        // Finder selection failed, show file picker
        setUseFilePicker(true);
      }

      setIsLoading(false);
    }

    initialize();
  }, []);

  // Handle file picker selection
  function handleFileChange(files: string[]) {
    if (files.length > 0) {
      const filePath = files[0];
      if (isSupportedFile(filePath)) {
        setSelectedFile(filePath);
        const formats = getOutputFormats(filePath);
        if (formats.length > 0) {
          setOutputFormat(formats[0]);
        }
      }
    } else {
      setSelectedFile(null);
      setOutputFormat("");
    }
  }

  // Handle conversion
  async function handleConvert() {
    if (!selectedFile || !outputFormat) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Missing Selection",
        message: "Please select a file and output format",
      });
      return;
    }

    setIsConverting(true);

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Converting...",
      message: path.basename(selectedFile),
    });

    try {
      let outputPaths: string[];

      // Check if this is a "both" format option
      if (outputFormat.includes("+")) {
        const formats = outputFormat.split("+");
        outputPaths = await convertDocumentMultiple(selectedFile, formats);
      } else {
        const outputPath = await convertDocument(selectedFile, outputFormat);
        outputPaths = [outputPath];
      }

      // Copy files to clipboard
      await copyFilesToClipboard(outputPaths);

      const fileNames = outputPaths.map((p) => path.basename(p)).join(", ");

      toast.style = Toast.Style.Success;
      toast.title = "Conversion Complete";
      toast.message = `${fileNames} (copied to clipboard)`;
      toast.primaryAction = {
        title: "Reveal in Finder",
        onAction: () => open(path.dirname(outputPaths[0])),
      };

      await showHUD(`✓ Converted: ${fileNames} (copied)`);

      // Open Finder to reveal the converted files
      await open(path.dirname(outputPaths[0]));

      await popToRoot();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Conversion Failed";
      toast.message = error instanceof Error ? error.message : "Unknown error";
    } finally {
      setIsConverting(false);
    }
  }

  // Get available formats for dropdown
  const availableFormats = selectedFile ? getOutputFormats(selectedFile) : [];

  return (
    <Form
      isLoading={isLoading || isConverting}
      actions={
        <ActionPanel>
          <Action title="Convert" onAction={handleConvert} shortcut={{ modifiers: ["cmd"], key: "return" }} />
        </ActionPanel>
      }
    >
      {useFilePicker ? (
        <Form.FilePicker
          id="file"
          title="Document"
          allowMultipleSelection={false}
          canChooseDirectories={false}
          value={selectedFile ? [selectedFile] : []}
          onChange={handleFileChange}
          info="Select a DOC or DOCX file to convert"
        />
      ) : (
        <Form.Description
          title="Selected File"
          text={selectedFile ? path.basename(selectedFile) : "No file selected"}
        />
      )}

      {selectedFile && (
        <>
          <Form.Description title="Source" text={selectedFile} />
          <Form.Dropdown id="format" title="Convert To" value={outputFormat} onChange={setOutputFormat}>
            {availableFormats.map((format) => (
              <Form.Dropdown.Item key={format} value={format} title={FORMAT_LABELS[format]} />
            ))}
          </Form.Dropdown>
        </>
      )}

      {!selectedFile && !isLoading && (
        <Form.Description
          title="No File Selected"
          text="Select a DOC or DOCX file in Finder, or use the file picker above."
        />
      )}
    </Form>
  );
}
