FROM python:3.12.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    S6_DATA_PATH=/app/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/deno.zip https://github.com/denoland/deno/releases/download/v2.3.0/deno-x86_64-unknown-linux-gnu.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && chmod +x /usr/local/bin/deno \
    && rm /tmp/deno.zip \
    && groupadd --system --gid 10001 s6cut \
    && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin s6cut

WORKDIR /app
COPY engine/requirements.lock /app/engine/requirements.lock
RUN python -m pip install --upgrade pip==26.0.1 \
    && python -m pip install --requirement /app/engine/requirements.lock
# Display faces for burned-in captions. Vendored rather than apt-installed so
# the render is reproducible: without them every style resolved to DejaVu Sans
# and libass emboldened it synthetically, which smears the outline. Each family
# ships its SIL Open Font License alongside it; see THIRD_PARTY_NOTICES.md and
# third_party_provenance.json.
COPY engine/fonts /usr/share/fonts/truetype/s6cut
RUN fc-cache -f
COPY engine /app/engine
RUN mkdir -p /app/data && chown -R s6cut:s6cut /app

USER s6cut:s6cut
EXPOSE 8001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "uvicorn", "engine.app:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/api/health', timeout=5)"
