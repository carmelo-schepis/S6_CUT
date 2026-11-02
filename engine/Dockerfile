FROM python:3.12.12-slim-bookworm

ARG TARGETARCH

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    S6_DATA_PATH=/app/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini curl unzip \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH}" in amd64) deno_arch=x86_64 ;; arm64) deno_arch=aarch64 ;; *) echo "Unsupported Deno target architecture: ${TARGETARCH}" >&2; exit 1 ;; esac \
    && deno_archive="deno-${deno_arch}-unknown-linux-gnu.zip" \
    && deno_base="https://github.com/denoland/deno/releases/download/v2.3.1" \
    && curl -fsSL -o "/tmp/${deno_archive}" "${deno_base}/${deno_archive}" \
    && curl -fsSL -o "/tmp/${deno_archive}.sha256sum" "${deno_base}/${deno_archive}.sha256sum" \
    && (cd /tmp && sha256sum -c "${deno_archive}.sha256sum") \
    && unzip -q "/tmp/${deno_archive}" -d /usr/local/bin \
    && chmod +x /usr/local/bin/deno \
    && rm -f "/tmp/${deno_archive}" "/tmp/${deno_archive}.sha256sum" \
    && groupadd --system --gid 10001 s6cut \
    && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin s6cut

WORKDIR /app
COPY engine/requirements.lock /app/engine/requirements.lock
RUN python -m pip install --upgrade pip==26.2.2 \
    && python -m pip install --requirement /app/engine/requirements.lock
# Display faces for burned-in captions. Vendored rather than apt-installed so
# the render is reproducible: without them every style resolved to DejaVu Sans
# and libass emboldened it synthetically, which smears the outline. Each family
# ships its SIL Open Font License alongside it; see THIRD_PARTY_NOTICES.md and
# third_party_provenance.json.
COPY engine/fonts /usr/share/fonts/truetype/s6cut
RUN fc-cache -f
COPY engine /app/engine
COPY third_party_provenance.json /app/third_party_provenance.json
RUN mkdir -p /app/data && chown -R s6cut:s6cut /app

USER s6cut:s6cut
EXPOSE 8001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "uvicorn", "engine.app:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/api/health', timeout=5)"
