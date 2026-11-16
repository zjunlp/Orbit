"""Export the pinned public HLE split; never mount the answer index in solve."""
import argparse
import base64
import hashlib
import json
from pathlib import Path

DATASET_REVISION = '5a81a4c7271a2a2a312b9a690f0c2fde837e4c29'
PARQUET_SHA256 = '6d0ee0602e8aea6b159509577e884f48ecac7b8e3f6822a35f51335a446c726a'


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False))


def prepare(parquet, output):
    import pyarrow.parquet as pq
    if output.exists() and any(output.iterdir()):
        raise ValueError('Prepare into an empty output directory')
    if sha(parquet) != PARQUET_SHA256:
        raise ValueError('Expected the pinned original cais/hle Parquet')
    rows = pq.read_table(parquet).to_pylist()
    tasks, answers = [], {}
    for row in rows:
        ident = row['id']
        if not ident.isalnum() or ident in answers:
            raise ValueError('Invalid or duplicate original question ID')
        folder = output / 'questions' / ident
        folder.mkdir(parents=True, exist_ok=True)
        image = row.get('image') or ''
        if image:
            header, encoded = image.split(',', 1)
            if not header.startswith('data:image/') or not header.endswith(';base64'):
                raise ValueError('Unexpected original image encoding')
            (folder / 'image.png').write_bytes(base64.b64decode(encoded, validate=True))
        question = {'id': ident, 'question': row['question'], 'image': 'image.png' if image else None}
        write(folder / 'question.json', question)
        files = {f.name: sha(f) for f in sorted(folder.iterdir()) if f.is_file()}
        tasks.append({'id': ident, 'title': row['question'][:160], 'files': files,
                      'image': bool(image), 'category': row.get('category') or 'unknown'})
        answers[ident] = {'id': ident, 'question': row['question'], 'answer': row['answer']}
    write(output / 'answers.json', answers)
    write(output / 'catalog.json', {'dataset': 'cais/hle', 'revision': DATASET_REVISION,
                                    'parquetSha256': PARQUET_SHA256, 'answersSha256': sha(output / 'answers.json'), 'tasks': tasks})
    print(json.dumps({'tasks': len(tasks), 'images': sum(t['image'] for t in tasks),
                      'catalogSha256': sha(output / 'catalog.json')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('parquet', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    prepare(args.parquet, args.output)
