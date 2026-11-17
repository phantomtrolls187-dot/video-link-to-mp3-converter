
const input = document.getElementById("videoUrl");
const button = document.getElementById("convertBtn");
const btnText = document.getElementById("btnText");
const statusBox = document.getElementById("status");
const statusText = document.getElementById("statusText");
const progress = document.getElementById("progress");

document.getElementById("clearBtn").addEventListener("click", () => {
  input.value = "";
  input.focus();
  setStatus("Ready when you are", "");
});

function setStatus(message, kind) {
  statusText.textContent = message;
  statusBox.className = "status" + (kind ? " " + kind : "");
}

button.addEventListener("click", async () => {
  const url = input.value.trim();

  if (!url) {
    setStatus("Paste a direct video-file URL first.", "error");
    input.focus();
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    setStatus("That URL doesn't look valid. Please check it.", "error");
    return;
  }

  if (parsed.protocol !== "https:") {
    setStatus("Please use an HTTPS video-file URL.", "error");
    return;
  }

  button.disabled = true;
  btnText.textContent = "CONVERTING...";
  progress.classList.remove("hidden");
  setStatus("Downloading and converting your video…", "");

  try {
    const response = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const type = response.headers.get("content-type") || "";

    if (!response.ok) {
      let message = "Conversion failed. Please try another authorized direct video URL.";

      if (type.includes("application/json")) {
        const data = await response.json();
        message = data.error || message;
      }

      throw new Error(message);
    }

    const blob = await response.blob();

    if (!blob.size) {
      throw new Error("The server returned an empty audio file.");
    }

    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = objectUrl;
    a.download = "converted-audio.mp3";
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    setStatus("Done! Your MP3 download has started.", "success");

  } catch (err) {
    setStatus(err.message || "Something went wrong.", "error");

  } finally {
    button.disabled = false;
    btnText.textContent = "CONVERT TO MP3";
    progress.classList.add("hidden");
  }
});

input.addEventListener("keydown", e => {
  if (e.key === "Enter") button.click();
});
