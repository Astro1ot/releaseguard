"""Reuse Docker's local dependency images in kind instead of downloading them twice."""
import os
from pathlib import Path
import subprocess
import tempfile
import platform

ROOT = Path(__file__).resolve().parents[1]
os.environ['PATH'] = str(ROOT / '.tools') + os.pathsep + os.environ['PATH']
IMAGES = ['postgres:17.6-bookworm', 'redis:7.4.5-alpine', 'apache/kafka:3.9.1', 'nginxinc/nginx-unprivileged:1.28-alpine']

if __name__ == '__main__':
    for image in IMAGES:
        cached = subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if cached.returncode: subprocess.run(['docker', 'pull', image], check=True)
    # Docker Desktop's containerd store may retain a multi-architecture index
    # without all its referenced layers. kind's --all-platforms import rejects
    # that incomplete index. Export only the platform we actually downloaded.
    arch = 'arm64' if platform.machine().lower() in {'arm64', 'aarch64'} else 'amd64'
    artifacts = (ROOT / 'artifacts').resolve(); artifacts.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='image-export-', dir=artifacts) as directory:
        assert Path(directory).resolve().is_relative_to(artifacts)
        archive = str(Path(directory) / 'dependencies.tar')
        subprocess.run(['docker', 'image', 'save', '--platform', f'linux/{arch}', '-o', archive, *IMAGES], check=True)
        subprocess.run(['kind', 'load', 'image-archive', archive, '--name', 'releaseguard'], check=True)
