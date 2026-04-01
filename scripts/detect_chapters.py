#!/usr/bin/env python3
"""
PDF Chapter Detector - Extracts chapters from a PDF using PyMuPDF
Output: JSON array of detected chapters with title and start_page
"""

import sys
import json
import re
import fitz  # PyMuPDF

# Regex patterns for chapter detection
CHAPTER_PATTERNS = [
    re.compile(r'^Chapter\s+(\d+|[IVXLCDM]+)[\s:.\-]+(.*)$', re.IGNORECASE),
    re.compile(r'^CHAPTER\s+(\d+|[IVXLCDM]+)[\s:.\-]+(.*)$'),
    re.compile(r'^Ch\.\s*(\d+)[\s:.\-]+(.*)$', re.IGNORECASE),
    re.compile(r'^(\d+)\.\s+([A-Z][^.]+)$'),
    re.compile(r'^Part\s+(\d+|[IVXLCDM]+)[\s:.\-]+(.*)$', re.IGNORECASE),
]


def get_page_text_lines(page, max_lines=10):
    """Extract first N lines of text from a page."""
    text = page.get_text("text")
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    return lines[:max_lines]


def match_chapter_pattern(lines):
    """Check if any line matches a chapter pattern."""
    for line in lines:
        for pattern in CHAPTER_PATTERNS:
            match = pattern.match(line)
            if match:
                number = match.group(1)
                title = match.group(2).strip() if match.lastindex >= 2 else ""
                if title:
                    return f"Chapter {number} - {title}"
                return f"Chapter {number}"
    return None


def detect_by_font_size(page):
    """Detect large text (font size > 16) at beginning of page."""
    blocks = page.get_text("dict")["blocks"]
    
    for block in blocks[:3]:  # Check first 3 blocks only
        if "lines" not in block:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                text = span["text"].strip()
                font_size = span["size"]
                
                if font_size > 16 and len(text) > 3 and text[0].isupper():
                    # Truncate to 50 characters
                    if len(text) > 50:
                        text = text[:50] + "..."
                    return text
    return None


def detect_chapters(pdf_path):
    """Detect chapters in a PDF file."""
    doc = fitz.open(pdf_path)
    chapters = []
    total_pages = len(doc)
    
    for page_num in range(total_pages):
        page = doc[page_num]
        page_number = page_num + 1  # 1-indexed
        
        # Already detected a chapter on this page?
        if any(c["start_page"] == page_number for c in chapters):
            continue
        
        # Try text pattern matching first
        lines = get_page_text_lines(page, 10)
        chapter_title = match_chapter_pattern(lines)
        
        if chapter_title:
            chapters.append({
                "title": chapter_title,
                "start_page": page_number
            })
            continue
        
        # Try font size analysis if no pattern match
        large_text = detect_by_font_size(page)
        if large_text:
            chapters.append({
                "title": large_text,
                "start_page": page_number
            })
    
    doc.close()
    
    return {
        "chapters": chapters,
        "total_pages": total_pages
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: detect_chapters.py <pdf_path>"}))
        sys.exit(1)
    
    pdf_path = sys.argv[1]
    
    try:
        result = detect_chapters(pdf_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
