import os
import subprocess

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None

def transcribe_audio(audio_path: str) -> str:
    """
    Transcribes the given audio file.
    Implements a Dual-Engine Pipeline:
    1. Attempts to run compiled whisper.cpp
    2. Falls back to faster-whisper if compilation/binary fails
    """
    whisper_cpp_dir = os.path.join(os.path.dirname(__file__), "whisper.cpp")
    binary_path = os.path.join(whisper_cpp_dir, "main")
    model_path = os.path.join(whisper_cpp_dir, "models", "ggml-base.en.bin")
    
    wav_path = audio_path + ".wav"
    try:
        # Pre-convert any audio format (webm/mp4/ogg) from the browser to 16kHz WAV
        # This fixes the "Invalid data found" ffmpeg errors in faster-whisper with Safari mp4s
        subprocess.run(
            ["ffmpeg", "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav_path],
            check=True, capture_output=True
        )
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.decode('utf-8') if e.stderr else str(e)
        return f"Error: Failed to convert audio using ffmpeg. Details: {error_msg}"
    except Exception as e:
        return f"Error: Failed to convert audio using ffmpeg. {e}"

    # Check if compiled binary and model exist
    if os.path.exists(binary_path) and os.path.exists(model_path):
        try:
            result = subprocess.run([binary_path, "-m", model_path, "-f", wav_path, "-nt"], capture_output=True, text=True, check=True)
            text = result.stdout.strip()
            
            if os.path.exists(wav_path):
                os.remove(wav_path)
                
            if text:
                return text
        except Exception as e:
            print(f"Whisper.cpp execution failed: {e}. Falling back to faster-whisper.")
    else:
        print("Whisper.cpp binary or model not found. Falling back to faster-whisper.")
        
    # Fallback to faster-whisper
    try:
        if WhisperModel is None:
            if os.path.exists(wav_path):
                os.remove(wav_path)
            return "Error: faster-whisper is not installed. Please install it to enable fallback transcription."
            
        model = WhisperModel("base.en", device="cpu", compute_type="int8")
        segments, info = model.transcribe(wav_path, beam_size=5)
        text = " ".join([segment.text for segment in segments])
        
        if os.path.exists(wav_path):
            os.remove(wav_path)
            
        return text.strip()
    except Exception as e:
        if os.path.exists(wav_path):
            os.remove(wav_path)
        return f"Error in transcription fallback: {e}"
