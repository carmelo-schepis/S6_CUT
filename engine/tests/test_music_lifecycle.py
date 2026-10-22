from __future__ import annotations

import json
import shutil
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from engine import app as app_module, jobs as jobs_module, media
from engine.config import Settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.models import CaptionCue, Clip, Job, MusicTrackSnapshot, Project
from engine.providers import ProfileService
from engine.security import SecretVault


@pytest.fixture()
def cluster(tmp_path: Path, monkeypatch):
    runtime = replace(Settings.from_env(), data_path=tmp_path)
    database = Database(tmp_path / 'test.sqlite3')
    rules = LibraryRules(database, tmp_path / 'library')
    manager = JobManager(database, rules, ProfileService(database, SecretVault(tmp_path / 'key')), runtime)
    for name, value in [('db', database), ('rules', rules), ('manager', manager), ('settings', runtime)]:
        monkeypatch.setattr(app_module, name, value)
    metadata = {'duration': 30.0, 'width': 1920, 'height': 1080, 'audio': False}
    monkeypatch.setattr(jobs_module, 'probe', lambda *args, **kwargs: metadata)
    monkeypatch.setattr(media, 'probe_audio', lambda *args, **kwargs: {'duration': 4, 'audio_codec': 'mp3'})
    async def enqueue(_job_id):
        return None
    monkeypatch.setattr(manager, 'enqueue', enqueue)
    folder = database.list_folders()[0].id
    project = Project(id='project', name='Soundtrack lifecycle', mode='clip', style='educational', state='active', source_name='silent.mp4', source_kind='upload', requested_count=1, latest_job_id='job', source_profile='music', library_folder_id=folder)
    database.save_project(project)
    source = tmp_path / 'jobs/job/source/source.mp4'
    source.parent.mkdir(parents=True)
    source.write_bytes(b'silent-video')
    track = source.with_name('background.mp3')
    track.write_bytes(b'original-song')
    asset = rules.register_file(track, title='Background song', media_type='audio/mpeg', origin='manual-import', folder_id=folder)
    snapshot = MusicTrackSnapshot(asset_id=asset.id, title=asset.title, source='upload', speed=1.25)
    clip = Clip(id='clip', index=1, state='queued', start=10, end=20, duration=10, opening_line='Original lyrics', music_track=snapshot)
    job = Job(id='job', project_id=project.id, mode='clip', state='active', stage='render', stage_label='Rendering', progress=50, style='educational', source_profile='music', music_track=snapshot, library_folder_id=folder, clips=[clip], steps=manager._smart_steps(source_profile='music'))
    private = {'source_path': str(source), 'source_hash': media.sha256_file(source), 'source_metadata': metadata, 'source_kind': 'upload', 'music_track_path': str(track), 'music_track_hash': asset.content_hash, 'music_track_asset_id': asset.id, 'music_track_speed': 1.25, 'music_presentation': {'version': 1, 'subtitle_theme': 'warm'}, 'aspect_ratio': '16:9', 'processing_mode': 'smart', 'count': 1, 'min_duration': 8, 'max_duration': 20}
    database.save_job(job, private)
    manager._register_source(job, private, source)
    output = tmp_path / 'jobs/job/clips/original.mp4'
    output.parent.mkdir(parents=True)
    output.write_bytes(b'original-output')
    job, clip, _ = manager._publish_output(job, clip, output, private)
    job.state, job.stage, job.progress = 'complete', 'complete', 100
    for step in job.steps:
        manager._apply_step(job, step, status='complete')
    manager._save(job, private)
    captured = {}
    def prepare(song, target, speed, settings, **kwargs):
        captured.update(song=song, speed=speed, duration=kwargs['duration'])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b'prepared-song')
        return target
    def render(source, output, **kwargs):
        captured.update(kwargs)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b'reviewed-output')
        output.with_suffix('.srt').write_text('1\n00:00:00,000 --> 00:00:01,000\nReviewed lyrics\n')
    monkeypatch.setattr(media, 'prepare_music_track', prepare)
    monkeypatch.setattr(media, 'render_fast_clip', render)
    return database, manager, rules, runtime, captured


def queue_review(database, client):
    response = client.put('/api/v1/jobs/job/clips/clip/captions', json={'revision': 0, 'cues': [{'id': 'cue', 'start': 0, 'end': 1, 'text': 'Reviewed lyrics'}]})
    assert response.status_code == 200, response.text
    response = client.post('/api/v1/jobs/job/clips/clip/captions/rerender?revision=1')
    assert response.status_code == 200, response.text
    assert database.get_job('job').state == 'queued'
    assert next(step for step in database.get_job('job').steps if step.id == 'ready').status == 'pending'


@pytest.mark.parametrize('prune_workspace', [False, True])
def test_reviewed_music_finishes_and_exports_after_retention(cluster, prune_workspace):
    database, manager, _, runtime, captured = cluster
    original = database.get_job('job').clips[0]
    if prune_workspace:
        shutil.rmtree(runtime.data_path / 'jobs/job')
    client = TestClient(app_module.app)
    queue_review(database, client)
    manager._process('job')
    finished = database.get_job('job')
    assert finished.state == 'complete', finished.error
    assert not any(step.status in {'pending', 'active'} for step in finished.steps)
    assert finished.clips[0].blob_id != original.blob_id
    assert finished.clips[0].library_asset_id == original.library_asset_id
    assert captured['speed'] == 1.25
    assert captured['duration'] == 30
    assert captured['music_track_speed'] == 1.0
    assert captured['music_track'].read_bytes() == b'prepared-song'
    assert finished.clips[0].music_track.speed == 1.25
    assert not database.get_job_private('job').get('caption_rerender_error')
    archive = manager.build_export('job', ['clip'])
    with zipfile.ZipFile(archive) as export:
        manifest = json.loads(export.read('Soundtrack lifecycle/manifest.json'))
        credits = json.loads(export.read('Soundtrack lifecycle/credits.json'))
    assert manifest['outputs'][0]['music_track']['speed'] == 1.25
    assert credits['credits'][-1]['music_track']['title'] == 'Background song'


def test_missing_saved_song_keeps_original_output_and_finishes(cluster):
    database, manager, _, runtime, _ = cluster
    job = database.get_job('job')
    original = job.clips[0].blob_id
    asset = database.get_asset(job.music_track.asset_id)
    (runtime.data_path / database.blob_relative_path(asset.blob_id)).unlink()
    Path(database.get_job_private('job')['music_track_path']).unlink()
    client = TestClient(app_module.app)
    queue_review(database, client)
    manager._process('job')
    finished = database.get_job('job')
    assert finished.state == 'complete'
    assert finished.clips[0].blob_id == original
    assert 'missing' in database.get_job_private('job')['caption_rerender_error']
    assert any('previous output retained' in warning for warning in finished.warnings)
    assert not any(step.status in {'pending', 'active'} for step in finished.steps)


def test_caption_queue_race_restores_terminal_job(cluster, monkeypatch):
    from engine.jobs import QueueFullError
    database, manager, *_ = cluster
    client = TestClient(app_module.app)
    edited = client.put('/api/v1/jobs/job/clips/clip/captions', json={'revision': 0, 'cues': [{'id': 'cue', 'start': 0, 'end': 1, 'text': 'Reviewed'}]})
    assert edited.status_code == 200
    async def full(_job_id):
        raise QueueFullError('Queue filled before enqueue')
    monkeypatch.setattr(manager, 'enqueue', full)
    response = client.post('/api/v1/jobs/job/clips/clip/captions/rerender?revision=1')
    assert response.status_code == 429
    assert database.get_job('job').state == 'complete'
    assert not database.get_job_private('job').get('caption_rerender')


def test_editing_during_caption_render_returns_conflict(cluster):
    database, *_ = cluster
    client = TestClient(app_module.app)
    queue_review(database, client)
    response = client.put('/api/v1/jobs/job/clips/clip/captions', json={'revision': 1, 'cues': [{'id': 'cue', 'start': 0, 'end': 1, 'text': 'Another edit'}]})
    assert response.status_code == 409


@pytest.mark.parametrize('stop_before_worker', [False, True])
def test_stop_wins_after_song_import_retry(cluster, monkeypatch, stop_before_worker):
    import asyncio
    database, manager, *_ = cluster
    job = database.get_job('job')
    private = database.get_job_private('job')
    private['music_track_url'] = 'https://music.youtube.com/watch?v=BaW_jenozKc'
    job.state = 'failed'
    job.clips = []
    for step in job.steps:
        manager._apply_step(job, step, status='pending')
        step.started_at = step.completed_at = None
    database.save_job(job, private)
    asyncio.run(manager.control('job', 'retry-import'))
    called = []
    def process(current, payload):
        called.append(True)
        assert not payload.get('retry_import')
        stopped = database.get_job(current.id)
        stopped.state = 'cancelled_kept'
        database.save_job(stopped)
        current.state = 'active'
        manager._save(current, payload)
    monkeypatch.setattr(manager, '_process_clip', process)
    if stop_before_worker:
        stopped = database.get_job('job')
        stopped.state = 'cancelled_kept'
        database.save_job(stopped)
    manager._process('job')
    assert database.get_job('job').state == 'cancelled_kept'
    assert bool(called) is not stop_before_worker


def test_export_manifest_adds_resolved_music_presentation_keys(cluster):
    from engine.models import MusicPresentationConfig

    database, manager, _, _, _ = cluster
    job = database.get_job('job')
    job.music_presentation = MusicPresentationConfig(subtitle_theme='condensed_white', lyric_animation='slow_fade', hook_text_format='white_banner')
    job.music_top_text = 'Exact hook'
    database.save_job(job)
    archive = manager.build_export('job', ['clip'])
    with zipfile.ZipFile(archive) as export:
        names = sorted(export.namelist())
        manifest = json.loads(export.read('Soundtrack lifecycle/manifest.json'))
    output = manifest['outputs'][0]
    assert output['music_presentation'] == {'subtitle_theme': 'condensed_white', 'lyric_animation': 'slow_fade', 'hook_text_format': 'white_banner'}
    assert output['music_top_text'] == 'Exact hook'
    # Existing keys and files are untouched.
    assert {'music_track', 'music_audio', 'hook_text', 'provenance', 'filename'} <= set(output)
    assert any(name.endswith('manifest.json') for name in names) and any(name.endswith('.mp4') for name in names)
    # Omitted options resolve to Original / Plain without inventing a hook.
    job.music_presentation = MusicPresentationConfig(subtitle_theme='warm')
    job.music_top_text = None
    database.save_job(job)
    with zipfile.ZipFile(manager.build_export('job', ['clip'])) as export:
        resolved = json.loads(export.read('Soundtrack lifecycle/manifest.json'))['outputs'][0]
    assert resolved['music_presentation'] == {'subtitle_theme': 'warm', 'lyric_animation': 'legacy', 'hook_text_format': 'plain'}
    assert resolved['music_top_text'] is None
