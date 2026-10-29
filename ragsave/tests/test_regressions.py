"""Регрессии аудита: безопасность файлов, свежесть, корень и размер выдачи."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ragsave import config, server
from ragsave.chunker import chunk_text
from ragsave.indexer import _scan_one, index_project, list_indexable_files
from ragsave.retrieval import current_hits, search_limit
from ragsave.store import FileRecord, SearchHit, Store
from test_ragsave import FakeEmbedder


class RetrievalRegressions(unittest.TestCase):
    def setUp(self) -> None:
        self.base = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.root = self.base / 'repo'
        self.root.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True)
        self.encoder = FakeEmbedder()
        self.enterContext(patch.object(config, 'EMBED_DIM', self.encoder.dim))
        self.enterContext(patch.object(server, '_embedder', self.encoder))

    def test_symlinks_to_external_and_internal_secrets_are_excluded(self) -> None:
        secret = self.base / '.env'
        secret.write_text('AUDIT_SYNTHETIC_SECRET', encoding='utf-8')
        (self.root / 'outside.txt').symlink_to(secret)
        (self.root / '.env').write_text('AUDIT_INTERNAL_SECRET', encoding='utf-8')
        (self.root / 'inside.txt').symlink_to(self.root / '.env')
        (self.root / 'folder').symlink_to(self.base, target_is_directory=True)
        (self.root / 'normal.md').write_text('public content', encoding='utf-8')

        names = {name for _, name in list_indexable_files(self.root)[0]}
        self.assertEqual(names, {'normal.md'})
        self.assertFalse(config.is_project_file(self.root, 'folder/.env'))
        self.assertEqual(_scan_one(self.root / 'outside.txt', 'outside.txt', None, False).status, 'binary')
        with self.assertRaises(OSError):
            with config.open_project_file(self.root, 'folder/.env'):
                self.fail('symlink directory opened')

    def test_git_filenames_survive_quotes_unicode_and_newlines(self) -> None:
        names = {'a"b.txt', 'документ.md', 'two\nlines.txt'}
        for name in names:
            (self.root / name).write_text('text', encoding='utf-8')
        self.assertEqual({name for _, name in list_indexable_files(self.root)[0]}, names)

    def test_nested_index_wins_without_crossing_repository(self) -> None:
        child = self.root / 'packages' / 'child'
        (child / config.INDEX_DIR).mkdir(parents=True)
        (child / config.INDEX_DIR / config.DB_NAME).touch()
        nested = child / 'src'
        nested.mkdir()
        self.assertEqual(config.find_project_root(nested), child)
        self.assertEqual(server._resolve_root(str(child)), child)
        self.assertEqual(config.find_project_root(self.root), self.root)

    def test_stale_missing_and_replaced_symlink_hits_never_expose_text(self) -> None:
        path = self.root / 'note.md'
        path.write_text('original', encoding='utf-8')
        index_project(self.root, embedder=self.encoder)
        before = path.stat()
        path.write_text('modified', encoding='utf-8')
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        with Store(self.root / '.ragsave/rag.db') as store:
            hits = store.search(self.encoder.embed_query('original'), 'original')
            fresh, stale = current_hits(self.root, store, hits)
        self.assertEqual(fresh, [])
        self.assertEqual(stale, ['note.md'])
        response = server._do_search({'query': 'original', 'project': str(self.root)})
        self.assertIn('устаревшие', response.content[0].text)
        self.assertNotIn('\noriginal\n', response.content[0].text)
        path.unlink()
        secret = self.base / '.env'
        secret.write_text('replacement secret', encoding='utf-8')
        path.symlink_to(secret)
        response = server._do_search({'query': 'original', 'project': str(self.root)})
        self.assertNotIn('replacement secret', response.content[0].text)
        path.unlink()
        response = server._do_search({'query': 'original', 'project': str(self.root)})
        self.assertIn('устаревшие', response.content[0].text)

    def test_response_budget_and_duplicate_hits(self) -> None:
        path = self.root / 'note.md'
        path.write_text('fresh', encoding='utf-8')
        index_project(self.root, embedder=self.encoder)
        one = SearchHit('note.md', 1, 1, 'x' * 13_000, 1.0, False)
        two = SearchHit('note.md', 2, 2, 'y' * 13_000, 0.9, False)
        huge = SearchHit('note.md', 3, 3, 'z' * 100_000, 0.8, False)
        with Store(self.root / '.ragsave/rag.db') as store:
            hits, stale = current_hits(self.root, store, [one, one, two, huge])
        self.assertEqual(hits, [one])
        self.assertEqual(stale, [])
        self.assertLessEqual(sum(len(hit.text) for hit in hits), config.SEARCH_MAX_CHARS)

    def test_oversized_legacy_cache_is_rebuilt_without_forced_reindex(self) -> None:
        text = 'x' * (config.CHUNK_CHARS * 3)
        path = self.root / 'note.md'
        path.write_text(text, encoding='utf-8')
        digest = hashlib.sha256(text.encode()).hexdigest()
        stat = path.stat()
        db_path = self.root / '.ragsave/rag.db'
        with Store(db_path) as store:
            store.stamp(self.encoder.model_name, self.encoder.dim, self.encoder.engine_version)
            record = FileRecord('note.md', digest, stat.st_size, stat.st_mtime)
            vectors = self.encoder.embed_passages([text])
            store.add_file('note.md', record, [(text, 1, 1)], vectors, False)
            store.put_cache(digest, [(text, 1, 1)], vectors)
        index_project(self.root, embedder=self.encoder)
        with Store(db_path) as store:
            self.assertEqual(store.oversized_files(), set())
            chunks, _ = store.cached_chunks(digest)
            self.assertTrue(all(len(row[0]) <= config.CHUNK_CHARS for row in chunks))

    def test_limits_and_sync_health_are_explicit(self) -> None:
        for invalid in [0, -1, config.SEARCH_MAX_HITS + 1]:
            with self.assertRaises(ValueError):
                search_limit(invalid)
        self.assertEqual(search_limit(None), 8)
        self.assertEqual(search_limit(3), 3)
        (self.root / 'note.md').write_text('fresh', encoding='utf-8')
        index_project(self.root, embedder=self.encoder)
        status = server._do_status({'project': str(self.root)}).content[0].text
        self.assertIn('"sync_health": "unknown"', status)


class ChunkRegressions(unittest.TestCase):
    def test_long_line_is_bounded_without_duplicate_tail(self) -> None:
        text = ''.join(str(index % 10) for index in range(100_003))
        chunks = chunk_text(text, 1600)
        self.assertTrue(all(len(chunk.text) <= 1600 for chunk in chunks))
        self.assertEqual(''.join(chunk.text for chunk in chunks), text)
        self.assertTrue(all(chunk.start_line == chunk.end_line == 1 for chunk in chunks))

    def test_multiline_budget_heading_and_line_ranges(self) -> None:
        text = '\n'.join(['# One', '', *[f'row {i} ' + 'x' * 12 for i in range(30)], '# Two', 'last'])
        chunks = chunk_text(text, 70)
        self.assertTrue(all(0 < len(chunk.text) <= 70 for chunk in chunks))
        self.assertTrue(any(chunk.text.startswith('# Two') for chunk in chunks))
        self.assertTrue(all(a.start_line <= b.start_line for a, b in zip(chunks, chunks[1:])))
        with self.assertRaises(ValueError):
            chunk_text('x', 0)


if __name__ == '__main__':
    unittest.main()
