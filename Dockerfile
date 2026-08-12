# S6_cut — default CPU-only, multi-architecture image.
# Optional NVIDIA acceleration is isolated in Dockerfile.gpu and
# docker-compose.gpu.yml; this image must never contain CUDA/NVIDIA packages.
FROM python:3.11-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC \
    PYTHONUNBUFFERED=1 \
    PATH=/app/data/bin:$PATH \
    S6CUT_DEVICE=cpu \
    GPU_RUNTIME=cpu

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 libcairo2 \
      curl unzip ca-certificates gosu && \
    curl -fsSL https://deno.land/install.sh | sh -s v2.8.3 && \
    mv /root/.deno/bin/deno /usr/local/bin/ && \
    rm -rf /root/.deno /var/lib/apt/lists/* && \
    AE_VERSION=30.5.0 && \
    ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  AE_ASSET=auto-editor-linux-x86_64;  AE_SHA=673e69b096d740736364f34669e864505294441f5ec9188642b33e24b07cf147 ;; \
      aarch64) AE_ASSET=auto-editor-linux-aarch64; AE_SHA=0c54d2cbc617fd369dae434eb62156557877da47c60fd8b2018b65b481166a4e ;; \
      *) echo "Unsupported architecture $ARCH for auto-editor; continuing with ffmpeg fallback"; AE_ASSET= ;; \
    esac && \
    if [ -n "$AE_ASSET" ]; then \
      curl -fsSL -o /usr/local/bin/auto-editor \
        "https://github.com/WyattBlue/auto-editor/releases/download/${AE_VERSION}/$AE_ASSET" && \
      echo "$AE_SHA  /usr/local/bin/auto-editor" | sha256sum -c - && \
      chmod +x /usr/local/bin/auto-editor; \
    fi

WORKDIR /app

COPY requirements-cpu.lock requirements-runtime-tools.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --upgrade pip && \
    python -m pip install -r requirements-cpu.lock -r requirements-runtime-tools.txt

RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser && \
    mkdir -p /app/uploads /app/output /app/data /app/data/bin /tmp/Ultralytics && \
    chown -R appuser:appuser /app /tmp/Ultralytics

COPY --chown=appuser:appuser . .
RUN python -m pip install --no-cache-dir -e . && \
    python scripts/verify_cpu_environment.py --installed --filesystem

USER appuser
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"

USER root
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["uvicorn", "s6_cut.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
