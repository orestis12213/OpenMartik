
import os
import shutil
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
from gradio_client import Client, handle_file

# Load environment variables
BASE = Path(__file__).parent
load_dotenv(BASE / ".env")

HF_TOKEN = os.getenv("HF_TOKEN")

app = FastAPI(title="OpenMartik AI")

OUTPUT = BASE / "outputs"
UPLOADS = BASE / "uploads"

OUTPUT.mkdir(exist_ok=True)
UPLOADS.mkdir(exist_ok=True)

HF_SPACE = "Lightricks/LTX-2.5"


@app.get("/")
def home():
    index = BASE / "index.html"

    if not index.is_file():
        raise HTTPException(404, "index.html not found")

    return FileResponse(index)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/generate")
def generate(
    prompt: str = Form(...),
    mode: str = Form("text"),
    image: UploadFile | None = File(None),
    duration: float = Form(2.0),
    height: int = Form(832),
    width: int = Form(832)
):
    if not prompt.strip():
        raise HTTPException(400, "Prompt is required")

    if mode not in ("text", "image"):
        raise HTTPException(400, "Invalid mode")

    if mode == "image" and image is None:
        raise HTTPException(400, "Upload an image first")

    if not 512 <= height <= 1536 or not 512 <= width <= 1536:
        raise HTTPException(400, "Invalid dimensions")

    if not 2 <= duration <= 20:
        raise HTTPException(400, "Duration must be between 2 and 20 seconds")

    if not HF_TOKEN:
        raise HTTPException(500, "HF_TOKEN is missing. Check your .env file.")

    image_file = None

    try:
        image_path = None

        if image is not None and image.filename:
            extension = Path(image.filename).suffix.lower()

            if extension not in (".png", ".jpg", ".jpeg", ".webp"):
                raise HTTPException(400, "Unsupported image format")

            image_file = UPLOADS / f"{uuid.uuid4()}{extension}"

            data = image.file.read(20 * 1024 * 1024 + 1)

            if len(data) > 20 * 1024 * 1024:
                raise HTTPException(413, "Image too large (max 20 MB)")

            image_file.write_bytes(data)
            image_path = handle_file(str(image_file))

        # Correct Hugging Face authentication parameter
        client = Client(
            HF_SPACE,
            token=HF_TOKEN
        )

        result = client.predict(
            prompt=prompt,
            image_path=image_path,
            height=height,
            width=width,
            duration_s=duration,
            seed=42,
            decoder="conv",
            auto_len=False,
            randomize_seed=True,
            do_enhance=True,
            api_name="/run"
        )

        video = result[0] if isinstance(result, (tuple, list)) else result

        if isinstance(video, dict):
            video = video.get("path") or video.get("video")

        if not isinstance(video, str):
            raise HTTPException(502, "Unexpected video response")

        source = Path(video)

        if not source.is_file():
            raise HTTPException(502, "Generated video not found")

        filename = f"{uuid.uuid4()}.mp4"
        destination = OUTPUT / filename

        shutil.copy2(source, destination)

        return {
            "status": "success",
            "video": f"/videos/{filename}",
            "prompt": prompt,
            "model": "LTX-2.5"
        }

    except HTTPException:
        raise

    except Exception as error:
        raise HTTPException(
            502,
            detail=f"Video generation failed: {error}"
        )

    finally:
        if image_file and image_file.exists():
            image_file.unlink()


@app.get("/videos/{filename}")
def get_video(filename: str):
    if Path(filename).name != filename:
        raise HTTPException(400, "Invalid filename")

    path = OUTPUT / filename

    if not path.is_file():
        raise HTTPException(404, "Video not found")

    return FileResponse(
        path,
        media_type="video/mp4",
        filename=filename
    )
