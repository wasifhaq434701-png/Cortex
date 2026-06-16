import io
import re
from datetime import datetime
from fpdf import FPDF


def _sanitize_text(text: str) -> str:
    """Remove or replace characters that latin-1 (fpdf default) can't encode."""
    if not text:
        return ""
    # Replace common unicode chars with ASCII equivalents
    replacements = {
        '\u2018': "'", '\u2019': "'",   # Smart quotes
        '\u201c': '"', '\u201d': '"',   # Smart double quotes
        '\u2013': '-', '\u2014': '--',  # En/em dashes
        '\u2026': '...', '\u2022': '*', # Ellipsis, bullet
        '\u2019': "'",
        '\u00a0': ' ',                  # Non-breaking space
        '\u200b': '',                   # Zero-width space
        '\u2002': ' ', '\u2003': ' ',   # En/em space
        '\ufeff': '',                   # BOM
        '\u2192': '->',                 # Right arrow
        '\u2190': '<-',                 # Left arrow
        '\u2264': '<=', '\u2265': '>=', # Comparison operators
        '\u00b2': '2', '\u00b3': '3',   # Superscripts
        '\u03b1': 'alpha', '\u03b2': 'beta', '\u03b3': 'gamma',  # Greek
        '\u03c3': 'sigma', '\u03bc': 'mu', '\u03c0': 'pi',
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    
    # Replace any remaining non-latin1 characters
    cleaned = text.encode('latin-1', errors='replace').decode('latin-1')
    return cleaned


class MindPalacePDF(FPDF):
    """Custom PDF class with Cortex branding."""
    
    def __init__(self, project_name="Cortex", session_name="Report"):
        super().__init__()
        self.project_name = _sanitize_text(project_name)
        self.session_name = _sanitize_text(session_name)
        self.set_auto_page_break(auto=True, margin=20)
    
    def header(self):
        # Accent bar at top
        self.set_fill_color(56, 189, 248)
        self.rect(0, 0, 210, 3, 'F')
        
        # Header text
        self.set_font('Helvetica', 'B', 9)
        self.set_text_color(100, 116, 139)
        self.set_y(6)
        self.cell(90, 6, self.project_name, align='L')
        self.cell(0, 6, self.session_name, align='R')
        self.ln(10)
        
        # Separator line
        self.set_draw_color(226, 232, 240)
        self.line(10, 18, 200, 18)
        self.ln(5)
    
    def footer(self):
        self.set_y(-15)
        self.set_font('Helvetica', 'I', 8)
        self.set_text_color(148, 163, 184)
        self.cell(0, 10, f'Cortex Report  |  Page {self.page_no()}/{{nb}}', align='C')


def create_pdf_from_session(session_data: dict) -> io.BytesIO:
    """
    Generates a styled PDF report from chat session messages.
    
    Expected session_data:
    {
        "projectName": "My Project",
        "sessionName": "Analysis Session",
        "modelUsed": "local",
        "messages": [
            {
                "narrative": "Analysis text here",
                "charts": [{ "type": "bar", "labels": [...], "data": [...], "label": "Title" }]
            }
        ]
    }
    """
    project_name = session_data.get('projectName', 'Cortex')
    session_name = session_data.get('sessionName', 'Analysis Report')
    model_used = session_data.get('modelUsed', 'Unknown Model')
    messages = session_data.get('messages', [])
    
    pdf = MindPalacePDF(project_name, session_name)
    pdf.alias_nb_pages()
    
    # ==================== TITLE PAGE ====================
    pdf.add_page()
    
    # Large title
    pdf.set_font('Helvetica', 'B', 32)
    pdf.set_text_color(15, 23, 42)
    pdf.ln(40)
    pdf.cell(0, 20, _sanitize_text(project_name), align='C')
    pdf.ln(20)
    
    # Accent divider
    pdf.set_fill_color(56, 189, 248)
    pdf.rect(70, pdf.get_y(), 70, 2, 'F')
    pdf.ln(12)
    
    # Session name
    pdf.set_font('Helvetica', '', 18)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(0, 12, _sanitize_text(session_name), align='C')
    pdf.ln(30)
    
    # Metadata
    pdf.set_font('Helvetica', '', 11)
    pdf.set_text_color(148, 163, 184)
    timestamp = datetime.now().strftime("%B %d, %Y at %H:%M")
    pdf.cell(0, 8, f"Generated on {timestamp}", align='C')
    pdf.ln(6)
    pdf.cell(0, 8, f"AI Model: {_sanitize_text(model_used)}", align='C')
    pdf.ln(6)
    pdf.cell(0, 8, f"Sections: {len(messages)}", align='C')
    
    # ==================== CONTENT PAGES ====================
    for msg_idx, msg in enumerate(messages):
        narrative = msg.get('narrative', '')
        charts = msg.get('charts', [])
        
        if not narrative and not charts:
            continue
        
        pdf.add_page()
        
        # Section header
        pdf.set_font('Helvetica', 'B', 16)
        pdf.set_text_color(56, 189, 248)
        pdf.cell(0, 10, f"Analysis {msg_idx + 1}", align='L')
        pdf.ln(4)
        
        # Accent underline
        pdf.set_fill_color(56, 189, 248)
        pdf.rect(10, pdf.get_y(), 40, 1.5, 'F')
        pdf.ln(10)
        
        # Narrative text
        if narrative:
            # Sanitize the entire narrative for latin-1 compatibility
            safe_narrative = _sanitize_text(narrative)
            paragraphs = [p.strip() for p in safe_narrative.split('\n') if p.strip()]
            
            for para in paragraphs:
                try:
                    # Detect bullet points
                    if para.startswith(('*', '-', '>', '  ')):
                        pdf.set_font('Helvetica', '', 10)
                        pdf.set_text_color(51, 65, 85)
                        pdf.set_x(15)
                        pdf.multi_cell(175, 6, f"  {para}")
                        pdf.ln(2)
                    elif len(para) < 80 and not para.endswith(('.', '!', '?', ':')):
                        # Short text = likely a sub-heading
                        pdf.set_font('Helvetica', 'B', 12)
                        pdf.set_text_color(30, 41, 59)
                        pdf.multi_cell(0, 7, para)
                        pdf.ln(3)
                    else:
                        # Regular paragraph
                        pdf.set_font('Helvetica', '', 10)
                        pdf.set_text_color(51, 65, 85)
                        pdf.multi_cell(0, 6, para)
                        pdf.ln(4)
                except Exception as e:
                    # If a paragraph still fails, skip it gracefully
                    print(f"PDF paragraph encoding error: {e}")
                    pdf.set_font('Helvetica', 'I', 9)
                    pdf.set_text_color(180, 180, 180)
                    pdf.multi_cell(0, 6, "[Content contained unsupported characters]")
                    pdf.ln(2)
        
        # Charts — render as images and embed
        if charts:
            try:
                from backend.ppt_generator import render_chart_to_image, PPT_THEMES
                theme = PPT_THEMES["dark"]
                
                for chart in charts:
                    img_buf = render_chart_to_image(chart, theme)
                    if img_buf:
                        import tempfile
                        import os
                        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
                        tmp.write(img_buf.read())
                        tmp.close()
                        
                        pdf.ln(5)
                        pdf.image(tmp.name, x=30, w=150)
                        pdf.ln(5)
                        
                        os.unlink(tmp.name)
            except Exception as e:
                pdf.set_font('Helvetica', 'I', 9)
                pdf.set_text_color(239, 68, 68)
                safe_err = _sanitize_text(str(e))
                pdf.cell(0, 8, f"[Chart rendering unavailable: {safe_err}]")
                pdf.ln(4)
    
    # Output — use pdf.output() which returns bytes directly
    # Do NOT pass a file-like object; fpdf2 handles it inconsistently
    pdf_bytes = pdf.output()
    output = io.BytesIO(pdf_bytes)
    output.seek(0)
    
    return output
