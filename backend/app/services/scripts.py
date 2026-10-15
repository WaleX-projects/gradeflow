import io

import fitz
from PIL import Image, ImageOps
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Paper, PaperPage
from app.services.private_storage import private_storage


def assemble_script_pdf(db: Session, paper: Paper) -> bytes:
    """Render an authorized script from its current page order and rotations."""
    pages = db.scalars(
        select(PaperPage)
        .where(PaperPage.organization_id == paper.organization_id, PaperPage.paper_id == paper.id)
        .order_by(PaperPage.page_number)
    ).all()
    if not pages:
        raise ValueError("This script has no pages to process")
    output = fitz.open()
    try:
        for page in pages:
            source_paper = db.get(Paper, page.source_paper_id or paper.id)
            if not source_paper or source_paper.organization_id != paper.organization_id:
                raise ValueError("A source scan for this page is unavailable")
            with private_storage().materialize(source_paper.storage_key) as path:
                if source_paper.content_type == "application/pdf":
                    with fitz.open(path) as source:
                        index = page.source_page_number - 1
                        if index < 0 or index >= source.page_count:
                            raise ValueError("A source page is outside the uploaded PDF")
                        source_rotation = source.load_page(index).rotation
                        output.insert_pdf(
                            source,
                            from_page=index,
                            to_page=index,
                            rotate=(source_rotation + page.rotation) % 360,
                        )
                else:
                    with Image.open(path) as original:
                        image = (
                            ImageOps.exif_transpose(original)
                            .convert("RGB")
                            .rotate(-page.rotation, expand=True)
                        )
                        width, height = image.size
                        scale = min(1.0, 1200 / max(width, height))
                        rendered = output.new_page(
                            width=max(1, width * scale), height=max(1, height * scale)
                        )
                        stream = io.BytesIO()
                        image.save(stream, format="JPEG", quality=90, optimize=True)
                        rendered.insert_image(rendered.rect, stream=stream.getvalue())
        if output.page_count != len(pages):
            raise ValueError("The script renderer did not create each confirmed page")
        result = output.tobytes(garbage=4, deflate=True)
        if not result or len(result) > 100 * 1024 * 1024:
            raise ValueError("The rendered script exceeds the 100 MB processing limit")
        return result
    finally:
        output.close()
