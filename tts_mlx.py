from kokoro_mlx import KokoroTTS
import soundfile as sf

print("Initializing Kokoro-MLX model (will download weights on first run)...")
# Automatically fetches the highly optimized bf16 weights from Hugging Face
tts = KokoroTTS.from_pretrained("mlx-community/Kokoro-82M-bf16")

text = "Hello! I am running the text to speech model natively on my MacBook Pro M5. The speed is incredible."

# Generate audio data (Default voice 'af_heart')
print("Synthesizing speech...")
result = tts.save(text, "mlx_output.wav", voice="af_heart", speed=1.0)

print("Finished! Check 'mlx_output.wav' in your folder.")
