
from contextlib import contextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Iterator

from app.core.config import settings


class PrivateStorage:
    def __init__(self):
        self.root = settings.storage_dir.resolve()
        self.client = None
        self.bucket = None
        if settings.storage_backend == "supabase":
            from supabase import create_client

            if not settings.supabase_url or not settings.supabase_storage_bucket:
                raise RuntimeError(
                    "GRADEFLOW_SUPABASE_URL and GRADEFLOW_SUPABASE_STORAGE_BUCKET "
                    "must be configured when Supabase storage is selected"
                )
            self.client = create_client(
                settings.supabase_url,
                settings.supabase_service_role_key_value,
            )
            self.bucket = self.client.storage.from_(settings.supabase_storage_bucket)

    @property
    def is_remote(self) -> bool:
        return self.bucket is not None

    def put(self, key: str, data: bytes, content_type: str) -> None:
        if self.bucket:
            # upsert=false mirrors the local "xb" mode: fail if the key already exists
            self.bucket.upload(
                path=key,
                file=data,
                file_options={"content-type": content_type, "upsert": "false"},
            )
            return
        path = self._local_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(data)

    def read(self, key: str) -> bytes:
        if self.bucket:
            return self.bucket.download(key)
        return self._local_path(key).read_bytes()

    def delete(self, key: str) -> None:
        if self.bucket:
            self.bucket.remove([key])
            return
        self._local_path(key).unlink(missing_ok=True)

    def _local_path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root not in path.parents:
            raise ValueError("Storage key is outside the private storage root")
        return path

    @contextmanager
    def materialize(self, key: str) -> Iterator[Path]:
        if not self.bucket:
            path = self._local_path(key)
            if not path.is_file():
                raise FileNotFoundError("Private scan was not found")
            yield path
            return
        suffix = Path(key).suffix
        local = NamedTemporaryFile(prefix="gradeflow-", suffix=suffix, delete=False)
        temp_path = Path(local.name)
        try:
            local.write(self.read(key))
            local.close()
            yield temp_path
        finally:
            local.close()
            temp_path.unlink(missing_ok=True)


_storage: PrivateStorage | None = None


def private_storage() -> PrivateStorage:
    global _storage
    if _storage is None:
        _storage = PrivateStorage()
    return _storage

'''

from contextlib import contextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Iterator

from app.core.config import settings


class PrivateStorage:
    def __init__(self):
        self.root = settings.storage_dir.resolve()
        self.client = None
        if settings.storage_backend == "s3":
            import boto3

            self.client = boto3.client(
                "s3",
                endpoint_url=settings.s3_endpoint_url,
                aws_access_key_id=settings.s3_access_key_value,
                aws_secret_access_key=settings.s3_secret_key_value,
                region_name=settings.s3_region,
            )
            if not settings.s3_bucket:
                raise RuntimeError(
                    "GRADEFLOW_S3_BUCKET must be configured when S3 storage is selected"
                )

    @property
    def is_s3(self) -> bool:
        return self.client is not None

    def put(self, key: str, data: bytes, content_type: str) -> None:
        if self.client:
            params = {
                "Bucket": settings.s3_bucket,
                "Key": key,
                "Body": data,
                "ContentType": content_type,
            }
            if settings.s3_server_side_encryption:
                params["ServerSideEncryption"] = "AES256"
            self.client.put_object(**params)
            return
        path = self._local_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(data)

    def read(self, key: str) -> bytes:
        if self.client:
            result = self.client.get_object(Bucket=settings.s3_bucket, Key=key)
            return result["Body"].read()
        return self._local_path(key).read_bytes()

    def delete(self, key: str) -> None:
        if self.client:
            self.client.delete_object(Bucket=settings.s3_bucket, Key=key)
            return
        self._local_path(key).unlink(missing_ok=True)

    def _local_path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root not in path.parents:
            raise ValueError("Storage key is outside the private storage root")
        return path

    @contextmanager
    def materialize(self, key: str) -> Iterator[Path]:
        if not self.client:
            path = self._local_path(key)
            if not path.is_file():
                raise FileNotFoundError("Private scan was not found")
            yield path
            return
        suffix = Path(key).suffix
        local = NamedTemporaryFile(prefix="gradeflow-", suffix=suffix, delete=False)
        temp_path = Path(local.name)
        try:
            local.write(self.read(key))
            local.close()
            yield temp_path
        finally:
            local.close()
            temp_path.unlink(missing_ok=True)


_storage: PrivateStorage | None = None


def private_storage() -> PrivateStorage:
    global _storage
    if _storage is None:
        _storage = PrivateStorage()
    return _storage
'''