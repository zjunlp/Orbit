# CHORES-S and CHORES-L

The two registrations cover the complete [published CHORES validation catalogs](https://github.com/spoc-robot/spoc-data). Each catalog entry has its own frozen instruction, house, start pose and goal. Each suite contains the same ten task types, with 1,887 episodes in CHORES-S and 2,091 in CHORES-L.

Both use the [pinned FLaRe native Stretch simulator and tasks](https://github.com/JiahengHu/FLaRe/tree/656f46ab332b09490d30bc62b9fb58b7b4ecfd0d). The 20-action controller includes navigation, arm, grasp, room confirmation and explicit episode end. The horizon is 600 steps for navigation and manipulation, and 1,000 for SimpleExploreHouse. Orbit records native success and success weighted by episode length (SEL). The Trial timeline shows both RGB cameras and the control trace. CPU verification uses the saved terminal observations of the native success conditions. For RoomVisit, it uses the registered room IDs and the room recorded at each `sub_done` to reconstruct the terminal list of confirmations. Older recordings are checked against the number of `sub_done` actions.

## Prepare, build and register

Download the validation `.jsonl.gz` files from `spoc-robot/spoc-data` on GitHub, using revision `771a5d65eea631355649e9ba22b920f0bf052e24` for CHORES-S and `da0b6a48c9e1abf26352aff51f04a13735053897` for CHORES-L. The pinned dataset loaders specify the public S3 URLs. Rename the downloaded files to their task names, for example `ObjectNavType.jsonl.gz`. Place the ten files for each suite in `$CHORES_DOWNLOADS/chores-small` and `$CHORES_DOWNLOADS/chores-large`.

Save the following archives in `$CHORES_DOWNLOADS`:

- [ObjaTHOR asset archive](https://pub-daedd7738a984186a00f2ab264d06a07.r2.dev/2023_07_28/assets.tar) and [annotations](https://pub-daedd7738a984186a00f2ab264d06a07.r2.dev/2023_07_28/annotations.json.gz).
- [ProcTHOR-Objaverse validation houses](https://pub-5932b61898254419952f5b13d42d82ab.r2.dev/procthor_objaverse%2F2023_07_28%2Fval.jsonl.gz).
- [Pinned AI2-THOR CloudRendering build](https://s3-us-west-2.amazonaws.com/ai2-thor-public/builds/thor-CloudRendering-966bd7758586e05d18f6181f459c0e90ba318bec.zip), assigned to `CHORES_UNITY`.

Set `FLARE_SOURCE` to the pinned FLaRe checkout and `CHORES_WORDNET` to a directory containing the NLTK data archives `wordnet.zip` and `wordnet2022.zip`. Use a fresh output directory for `CHORES_ASSETS`. The archive alone is about 28 GB before extraction.

Asset preparation verifies the archive against the SHA-256 in the [release manifest](release.json), then records and fingerprints each house's procedural objects, including textures and geometry. Registration checks that the prepared manifest records the same archive digest. Existing version 2 bundles with a matching digest can be registered directly. Solve checks the objects required by its selected houses once per batch.

The pinned archive SHA-256 was computed from bytes that matched the publisher's [multipart ETag](https://developers.cloudflare.com/r2/objects/upload-objects/#etags) with 5 MiB parts.

```bash
config=examples/bench-adapters/embodied/benchmarks/chores/configure_chores.py
python3 -B "$config" --prepare-assets --downloads "$CHORES_DOWNLOADS" --assets "$CHORES_ASSETS"
python3 -B "$config" --source "$FLARE_SOURCE" --unity-zip "$CHORES_UNITY" \
  --annotations "$CHORES_DOWNLOADS/annotations.json.gz" --wordnet "$CHORES_WORDNET" \
  --build-tag orbit/chores:reference
python3 -B "$config" --source "$FLARE_SOURCE" --downloads "$CHORES_DOWNLOADS" \
  --assets "$CHORES_ASSETS" --benchmark-image orbit/chores:reference --output-dir "$CHORES_CONFIG"

orbit data add chores-procthor-objaverse "$CHORES_ASSETS"
for suite in chores-small chores-large; do
  registration="$CHORES_CONFIG/$suite"
  orbit bench add-file "$registration/benchmark.json"
  python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$FLARE_SOURCE" \
    --reference-file "$registration/reference.json" --all-tasks --all-initial-states \
    > "$registration/samples.json"
done
```

See [SPOC and FLaRe](../../policies/chores/README.md) for model setup and short paired runs.
