import {
  List,
  ActionPanel,
  Action,
  Form,
  showToast,
  Toast,
  getSelectedFinderItems,
  showHUD,
  Icon,
  Color,
  useNavigation,
  open,
  popToRoot,
  confirmAlert,
  Alert,
  AI,
  environment,
} from "@raycast/api";
import { useState, useEffect, useCallback } from "react";
import * as fs from "fs";
import * as path from "path";
import { PDFDocument } from "pdf-lib";
import { execSync } from "child_process";

// ============================================================================
// Types
// ============================================================================

interface Chapter {
  id: string;
  title: string;
  startPage: number; // 1-indexed
  endPage: number; // 1-indexed
}

interface DetectedChapter {
  title: string;
  startPage: number;
}

// ============================================================================
// PDF Utilities
// ============================================================================

/**
 * Get total page count from a PDF file using pdf-lib
 */
async function getPdfPageCount(pdfPath: string): Promise<number> {
  const dataBuffer = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(dataBuffer);
  return pdfDoc.getPageCount();
}

/**
 * Extract text from a specific page using pdftotext CLI
 */
// Full path to pdftotext - Raycast extensions have limited PATH that excludes Homebrew
const PDFTOTEXT_PATH = "/opt/homebrew/bin/pdftotext";

function extractPageText(pdfPath: string, pageNum: number): string {
  try {
    // pdftotext uses 1-indexed pages, -f is first page, -l is last page
    // Removed -layout flag for cleaner text extraction without extra whitespace
    const result = execSync(
      `${PDFTOTEXT_PATH} -f ${pageNum} -l ${pageNum} "${pdfPath}" -`,
      { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 10000 }
    );
    return result;
  } catch (error) {
    console.log(`[DEBUG] extractPageText error on page ${pageNum}:`, error);
    return "";
  }
}

/**
 * Context passed to each chunk for better AI understanding
 */
interface ChunkContext {
  chunkNumber: number;
  totalChunks: number;
  pageRangeStart: number;
  pageRangeEnd: number;
  previouslyFoundChapters: DetectedChapter[];
}

/**
 * Process a chunk of PDF text with AI to detect chapters
 */
async function detectChaptersInChunk(
  chunkText: string,
  totalPages: number,
  context: ChunkContext
): Promise<DetectedChapter[]> {
  // Build context about previously found chapters
  let previousChaptersContext = "";
  if (context.previouslyFoundChapters.length > 0) {
    const chapterList = context.previouslyFoundChapters
      .map((c) => `  - "${c.title}" (starts on page ${c.startPage})`)
      .join("\n");
    previousChaptersContext = `
Previously detected chapters from earlier chunks:
${chapterList}

You should continue from where we left off. Do NOT re-detect these chapters.`;
  } else {
    previousChaptersContext = "This is the first chunk, no chapters have been detected yet.";
  }

  const prompt = `You are analyzing a PDF document to find chapter boundaries.

CONTEXT:
- This is chunk ${context.chunkNumber} of ${context.totalChunks}
- This chunk contains pages ${context.pageRangeStart} to ${context.pageRangeEnd} (out of ${totalPages} total pages)
${previousChaptersContext}

TASK:
Analyze the following PDF text and identify any NEW chapter boundaries in this chunk. Look for chapter titles, part titles, section headings, and other major divisions.

You are getting chunked text, so you may have content that is a continuation of a previous chapter - if so, just return an empty array since no NEW chapter starts in this chunk. Only return chapters that START within this chunk's page range.

For each NEW chapter you find, provide:
1. The exact title as it appears in the document
2. The page number where the chapter starts (shown as "--- PAGE X ---" markers)

Return your response as a JSON array with objects containing "title" and "startPage" fields. Only include actual chapters or major sections, not every heading.

Example response format:
[
  {"title": "Chapter 4 - Results", "startPage": 51},
  {"title": "Chapter 5 - Discussion", "startPage": 78}
]

If no new chapters start in this chunk, return an empty array: []

PDF Text:
${chunkText}`;

  try {
    const response = await AI.ask(prompt, {
      creativity: 0, // Use low creativity for structured extraction
    });

    console.log("[DEBUG] AI chunk response:", response.substring(0, 200) + "...");

    // Parse the JSON response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log("[DEBUG] No JSON array found in AI chunk response");
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{ title: string; startPage: number }>;
    
    // Validate and convert to DetectedChapter format
    return parsed
      .filter((item) => {
        const isValid = 
          typeof item.title === "string" && 
          typeof item.startPage === "number" &&
          item.startPage >= 1 &&
          item.startPage <= totalPages;
        if (!isValid) {
          console.log("[DEBUG] Skipping invalid chapter:", item);
        }
        return isValid;
      })
      .map((item) => ({
        title: item.title,
        startPage: item.startPage,
      }));
  } catch (error) {
    console.error("[DEBUG] AI chunk detection failed:", error);
    return [];
  }
}

/**
 * Detect chapters in a PDF using Raycast AI
 * Processes PDF in chunks to handle large documents
 */
async function detectChapters(pdfPath: string): Promise<{ chapters: DetectedChapter[]; totalPages: number }> {
  const totalPages = await getPdfPageCount(pdfPath);

  // Check if the user has access to AI
  if (!environment.canAccess(AI)) {
    console.log("[DEBUG] User does not have access to Raycast AI, falling back to empty chapters");
    return { chapters: [], totalPages };
  }

  // Extract text from all pages with page markers, grouped into chunks
  const PAGES_PER_CHUNK = 50; // Process 50 pages at a time
  interface ChunkData {
    text: string;
    startPage: number;
    endPage: number;
  }
  const chunks: ChunkData[] = [];
  let currentChunk = "";
  let chunkStartPage = 1;
  
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageText = extractPageText(pdfPath, pageNum);
    if (pageText.trim()) {
      currentChunk += `\n--- PAGE ${pageNum} ---\n${pageText}`;
    }
    
    // Start a new chunk every PAGES_PER_CHUNK pages
    if (pageNum % PAGES_PER_CHUNK === 0 || pageNum === totalPages) {
      if (currentChunk.trim()) {
        chunks.push({
          text: currentChunk,
          startPage: chunkStartPage,
          endPage: pageNum,
        });
      }
      currentChunk = "";
      chunkStartPage = pageNum + 1;
    }
  }

  console.log(`[DEBUG] Split PDF into ${chunks.length} chunks for processing`);

  // Process each chunk with AI and collect all chapters
  const allChapters: DetectedChapter[] = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[DEBUG] Processing chunk ${i + 1}/${chunks.length} (pages ${chunk.startPage}-${chunk.endPage})...`);
    
    const context: ChunkContext = {
      chunkNumber: i + 1,
      totalChunks: chunks.length,
      pageRangeStart: chunk.startPage,
      pageRangeEnd: chunk.endPage,
      previouslyFoundChapters: [...allChapters], // Pass all chapters found so far
    };
    
    const chunkChapters = await detectChaptersInChunk(chunk.text, totalPages, context);
    allChapters.push(...chunkChapters);
    
    console.log(`[DEBUG] Chunk ${i + 1} found ${chunkChapters.length} chapters. Total so far: ${allChapters.length}`);
  }

  // Deduplicate chapters (in case of overlap at chunk boundaries)
  const uniqueChapters = allChapters.reduce((acc: DetectedChapter[], chapter) => {
    const exists = acc.some(
      (c) => c.startPage === chapter.startPage || 
             (c.title.toLowerCase() === chapter.title.toLowerCase())
    );
    if (!exists) {
      acc.push(chapter);
    }
    return acc;
  }, []);

  // Sort by start page
  uniqueChapters.sort((a, b) => a.startPage - b.startPage);

  console.log(`[DEBUG] Total unique chapters detected: ${uniqueChapters.length}`);
  return { chapters: uniqueChapters, totalPages };
}

/**
 * Convert detected chapters to full Chapter objects with end pages
 */
function processChapters(detected: DetectedChapter[], totalPages: number): Chapter[] {
  const sorted = [...detected].sort((a, b) => a.startPage - b.startPage);

  return sorted.map((chapter, index) => ({
    id: `chapter-${index}-${Date.now()}`,
    title: chapter.title,
    startPage: chapter.startPage,
    endPage: index < sorted.length - 1 ? sorted[index + 1].startPage - 1 : totalPages,
  }));
}

/**
 * Recalculate end pages after modifications
 */
function recalculateEndPages(chapters: Chapter[], totalPages: number): Chapter[] {
  const sorted = [...chapters].sort((a, b) => a.startPage - b.startPage);
  return sorted.map((chapter, index) => ({
    ...chapter,
    endPage: index < sorted.length - 1 ? sorted[index + 1].startPage - 1 : totalPages,
  }));
}

// ============================================================================
// PDF Splitting
// ============================================================================

/**
 * Sanitize filename for safe file system usage
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s-]+/g, "_")
    .trim();
}

/**
 * Split a PDF into chapters
 */
async function splitPdf(
  pdfPath: string,
  chapters: Chapter[],
  outputDir: string,
  onProgress?: (current: number, total: number, filename: string) => void
): Promise<string[]> {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const outputPaths: string[] = [];

  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    const filename = `${String(i + 1).padStart(2, "0")}_${sanitizeFilename(chapter.title)}.pdf`;
    const outputPath = path.join(outputDir, filename);

    onProgress?.(i + 1, chapters.length, filename);

    // Create new PDF with chapter pages
    const newPdf = await PDFDocument.create();
    const pageIndices = [];
    for (let p = chapter.startPage - 1; p < chapter.endPage; p++) {
      pageIndices.push(p);
    }

    const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
    copiedPages.forEach((page) => newPdf.addPage(page));

    const newPdfBytes = await newPdf.save();
    fs.writeFileSync(outputPath, newPdfBytes);
    outputPaths.push(outputPath);
  }

  return outputPaths;
}

// ============================================================================
// Components
// ============================================================================

/**
 * Form for editing a chapter
 */
function EditChapterForm({
  chapter,
  totalPages,
  onSave,
}: {
  chapter: Chapter;
  totalPages: number;
  onSave: (updated: Chapter) => void;
}) {
  const { pop } = useNavigation();
  const [title, setTitle] = useState(chapter.title);
  const [startPage, setStartPage] = useState(String(chapter.startPage));

  function handleSubmit() {
    const pageNum = parseInt(startPage, 10);
    if (isNaN(pageNum) || pageNum < 1 || pageNum > totalPages) {
      showToast({
        style: Toast.Style.Failure,
        title: "Invalid Page Number",
        message: `Page must be between 1 and ${totalPages}`,
      });
      return;
    }

    onSave({
      ...chapter,
      title: title.trim() || chapter.title,
      startPage: pageNum,
    });
    pop();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Chapter" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Chapter Title" value={title} onChange={setTitle} />
      <Form.TextField
        id="startPage"
        title="Start Page"
        value={startPage}
        onChange={setStartPage}
        info={`Valid range: 1 - ${totalPages}`}
      />
    </Form>
  );
}

/**
 * Form for adding a new chapter
 */
function AddChapterForm({
  totalPages,
  onAdd,
}: {
  totalPages: number;
  onAdd: (title: string, startPage: number) => void;
}) {
  const { pop } = useNavigation();
  const [title, setTitle] = useState("");
  const [startPage, setStartPage] = useState("1");

  function handleSubmit() {
    const pageNum = parseInt(startPage, 10);
    if (isNaN(pageNum) || pageNum < 1 || pageNum > totalPages) {
      showToast({
        style: Toast.Style.Failure,
        title: "Invalid Page Number",
        message: `Page must be between 1 and ${totalPages}`,
      });
      return;
    }

    if (!title.trim()) {
      showToast({
        style: Toast.Style.Failure,
        title: "Title Required",
        message: "Please enter a chapter title",
      });
      return;
    }

    onAdd(title.trim(), pageNum);
    pop();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Chapter" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Chapter Title" value={title} onChange={setTitle} placeholder="Chapter 1 - Introduction" />
      <Form.TextField
        id="startPage"
        title="Start Page"
        value={startPage}
        onChange={setStartPage}
        info={`Valid range: 1 - ${totalPages}`}
      />
    </Form>
  );
}

/**
 * Form for selecting output directory before splitting
 */
function OutputDirectoryForm({
  defaultDir,
  chapters,
  pdfPath,
  onComplete,
}: {
  defaultDir: string;
  chapters: Chapter[];
  pdfPath: string;
  onComplete: () => void;
}) {
  const { pop } = useNavigation();
  const [outputDir, setOutputDir] = useState<string[]>([defaultDir]);
  const [isProcessing, setIsProcessing] = useState(false);

  async function handleSubmit() {
    if (outputDir.length === 0) {
      showToast({
        style: Toast.Style.Failure,
        title: "Output Directory Required",
        message: "Please select an output directory",
      });
      return;
    }

    setIsProcessing(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Splitting PDF...",
      message: `0/${chapters.length} chapters`,
    });

    try {
      const outputPaths = await splitPdf(pdfPath, chapters, outputDir[0], (current, total, filename) => {
        toast.message = `${current}/${total}: ${filename}`;
      });

      toast.style = Toast.Style.Success;
      toast.title = "Split Complete!";
      toast.message = `Created ${outputPaths.length} files`;

      await showHUD(`✓ Split into ${outputPaths.length} chapter files`);
      await open(outputDir[0]);

      onComplete();
      pop();
      await popToRoot();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Split Failed";
      toast.message = error instanceof Error ? error.message : "Unknown error";
      setIsProcessing(false);
    }
  }

  return (
    <Form
      isLoading={isProcessing}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Split PDF" onSubmit={handleSubmit} icon={Icon.Snippets} />
        </ActionPanel>
      }
    >
      <Form.Description title="Chapters" text={`${chapters.length} chapters will be created`} />
      <Form.FilePicker
        id="outputDir"
        title="Output Directory"
        allowMultipleSelection={false}
        canChooseDirectories={true}
        canChooseFiles={false}
        value={outputDir}
        onChange={setOutputDir}
      />
    </Form>
  );
}

/**
 * File picker for selecting a PDF
 */
function FilePickerView({ onSelect }: { onSelect: (path: string) => void }) {
  const [filePath, setFilePath] = useState<string[]>([]);

  function handleChange(files: string[]) {
    setFilePath(files);
    if (files.length > 0 && files[0].toLowerCase().endsWith(".pdf")) {
      onSelect(files[0]);
    }
  }

  return (
    <Form>
      <Form.FilePicker
        id="pdf"
        title="Select PDF"
        allowMultipleSelection={false}
        canChooseDirectories={false}
        value={filePath}
        onChange={handleChange}
        info="Select a PDF file to split by chapters"
      />
    </Form>
  );
}

// ============================================================================
// Main Command
// ============================================================================

export default function Command() {
  // Navigation hook available if needed in future
  useNavigation();
  const [isLoading, setIsLoading] = useState(true);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [showFilePicker, setShowFilePicker] = useState(false);

  // Get default output directory
  const getDefaultOutputDir = useCallback(() => {
    if (!pdfPath) return "";
    const dir = path.dirname(pdfPath);
    const basename = path.basename(pdfPath, ".pdf");
    return path.join(dir, `${basename}_chapters`);
  }, [pdfPath]);

  // Initialize - try to get PDF from Finder
  useEffect(() => {
    async function initialize() {
      try {
        const finderItems = await getSelectedFinderItems();
        const pdfFiles = finderItems.filter((item) => item.path.toLowerCase().endsWith(".pdf"));

        if (pdfFiles.length > 0) {
          setPdfPath(pdfFiles[0].path);
        } else {
          setShowFilePicker(true);
          setIsLoading(false);
        }
      } catch {
        setShowFilePicker(true);
        setIsLoading(false);
      }
    }

    initialize();
  }, []);

  // Load PDF and detect chapters when path changes
  useEffect(() => {
    async function loadPdf() {
      if (!pdfPath) return;

      setIsLoading(true);
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Analyzing PDF...",
        message: "Detecting chapters",
      });

      try {
        // Detect chapters using pdftotext CLI
        toast.message = "Scanning pages...";
        const { chapters: detected, totalPages: pages } = await detectChapters(pdfPath);
        setTotalPages(pages);

        // Process chapters with end pages
        const processed = processChapters(detected, pages);
        setChapters(processed);

        toast.style = Toast.Style.Success;
        toast.title = "PDF Loaded";
        toast.message = processed.length > 0
          ? `Found ${processed.length} chapters in ${pages} pages`
          : `${pages} pages - No chapters detected, add manually`;
      } catch (error) {
        toast.style = Toast.Style.Failure;
        toast.title = "Failed to Load PDF";
        toast.message = error instanceof Error ? error.message : "Unknown error";
      } finally {
        setIsLoading(false);
      }
    }

    loadPdf();
  }, [pdfPath]);

  // Handle file selection from picker
  function handleFileSelect(path: string) {
    setPdfPath(path);
    setShowFilePicker(false);
  }

  // Update a chapter
  function handleUpdateChapter(updated: Chapter) {
    setChapters((prev) => {
      const newChapters = prev.map((c) => (c.id === updated.id ? updated : c));
      return recalculateEndPages(newChapters, totalPages);
    });
  }

  // Add a new chapter
  function handleAddChapter(title: string, startPage: number) {
    setChapters((prev) => {
      const newChapter: Chapter = {
        id: `chapter-${Date.now()}`,
        title,
        startPage,
        endPage: totalPages, // Will be recalculated
      };
      return recalculateEndPages([...prev, newChapter], totalPages);
    });
  }

  // Delete a chapter
  async function handleDeleteChapter(chapter: Chapter) {
    if (
      await confirmAlert({
        title: "Delete Chapter?",
        message: `Are you sure you want to delete "${chapter.title}"?`,
        primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
      })
    ) {
      setChapters((prev) => {
        const newChapters = prev.filter((c) => c.id !== chapter.id);
        return recalculateEndPages(newChapters, totalPages);
      });
    }
  }

  // Refresh chapter detection
  // Note: Auto-detection removed due to Node.js compatibility issues with pdfjs-dist
  // Users can manually add chapters using the Add Chapter action

  // Show file picker if no PDF selected
  if (showFilePicker) {
    return <FilePickerView onSelect={handleFileSelect} />;
  }

  return (
    <List
      isLoading={isLoading}
      navigationTitle={pdfPath ? path.basename(pdfPath) : "Split PDF by Chapters"}
      searchBarPlaceholder="Search chapters..."
    >
      {chapters.length === 0 && !isLoading ? (
        <List.EmptyView
          title="No Chapters Detected"
          description="Use Add Chapter to manually define chapter boundaries"
          icon={Icon.Book}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Add Chapter"
                  icon={Icon.Plus}
                  target={<AddChapterForm totalPages={totalPages} onAdd={handleAddChapter} />}
                  shortcut={{ modifiers: ["cmd"], key: "n" }}
                />
              </ActionPanel>
            }
        />
      ) : (
        [...chapters].sort((a, b) => a.startPage - b.startPage).map((chapter, index) => (
          <List.Item
            key={chapter.id}
            title={chapter.title}
            subtitle={`Pages ${chapter.startPage} - ${chapter.endPage}`}
            icon={{ source: Icon.Document, tintColor: Color.Blue }}
            accessories={[
              { text: `${chapter.endPage - chapter.startPage + 1} pages` },
              { tag: { value: String(index + 1), color: Color.SecondaryText } },
            ]}
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  <Action.Push
                    title="Split PDF"
                    icon={Icon.Snippets}
                    target={
                      <OutputDirectoryForm
                        defaultDir={getDefaultOutputDir()}
                        chapters={chapters}
                        pdfPath={pdfPath!}
                        onComplete={() => {}}
                      />
                    }
                    shortcut={{ modifiers: ["cmd"], key: "return" }}
                  />
                </ActionPanel.Section>
                <ActionPanel.Section>
                  <Action.Push
                    title="Edit Chapter"
                    icon={Icon.Pencil}
                    target={
                      <EditChapterForm chapter={chapter} totalPages={totalPages} onSave={handleUpdateChapter} />
                    }
                    shortcut={{ modifiers: ["cmd"], key: "e" }}
                  />
                  <Action.Push
                    title="Add Chapter"
                    icon={Icon.Plus}
                    target={<AddChapterForm totalPages={totalPages} onAdd={handleAddChapter} />}
                    shortcut={{ modifiers: ["cmd"], key: "n" }}
                  />
                  <Action
                    title="Delete Chapter"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    onAction={() => handleDeleteChapter(chapter)}
                    shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
