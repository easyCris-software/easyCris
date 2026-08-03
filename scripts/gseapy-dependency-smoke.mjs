import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_VERSION = '1.1.11'
const EXPECTED_SEED = 20260728
const EXPECTED_PATHWAYS = ['PATHWAY_ALPHA', 'PATHWAY_BETA']
const METRICS = ['es', 'nes', 'nominal_p_value', 'fdr_q_value']

const PYTHON_PROBE = [
  'import json',
  'import pathlib',
  'import tempfile',
  'import gseapy',
  'import pandas',
  '',
  'SEED = 20260728',
  'ranking = pandas.DataFrame([',
  '    ("GENE01", 3.20),',
  '    ("GENE02", 2.70),',
  '    ("GENE03", 2.10),',
  '    ("GENE04", 1.40),',
  '    ("GENE05", 0.75),',
  '    ("GENE06", 0.20),',
  '    ("GENE07", -0.15),',
  '    ("GENE08", -0.65),',
  '    ("GENE09", -1.25),',
  '    ("GENE10", -1.90),',
  '    ("GENE11", -2.55),',
  '    ("GENE12", -3.10),',
  '], columns=["gene", "score"])',
  '',
  'def one_run(gmt_path):',
  '    result = gseapy.prerank(',
  '        rnk=ranking,',
  '        gene_sets=str(gmt_path),',
  '        min_size=2,',
  '        max_size=12,',
  '        permutation_num=256,',
  '        weight=1.0,',
  '        ascending=False,',
  '        threads=1,',
  '        seed=SEED,',
  '        outdir=None,',
  '        no_plot=True,',
  '        verbose=False,',
  '    ).res2d',
  '    rows = sorted(result.to_dict(orient="records"), key=lambda row: str(row["Term"]))',
  '    return {"pathways": [',
  '        {',
  '            "name": str(row["Term"]),',
  '            "es": float(row["ES"]),',
  '            "nes": float(row["NES"]),',
  '            "nominal_p_value": float(row["NOM p-val"]),',
  '            "fdr_q_value": float(row["FDR q-val"]),',
  '        }',
  '        for row in rows',
  '    ]}',
  '',
  'with tempfile.TemporaryDirectory(prefix="easycris-public-gseapy-") as temp_dir:',
  '    gmt_path = pathlib.Path(temp_dir) / "public-synthetic.gmt"',
  '    gmt_path.write_text(',
  '        "PATHWAY_ALPHA\\tpublic synthetic positive pathway\\tGENE01\\tGENE02\\tGENE03\\tGENE05\\n"',
  '        "PATHWAY_BETA\\tpublic synthetic negative pathway\\tGENE08\\tGENE10\\tGENE11\\tGENE12\\n",',
  '        encoding="utf-8",',
  '    )',
  '    runs = [one_run(gmt_path), one_run(gmt_path)]',
  '',
  'print(json.dumps({',
  '    "version": gseapy.__version__,',
  '    "seed": SEED,',
  '    "runs": runs,',
  '}, sort_keys=True, separators=(",", ":"), allow_nan=False))',
].join('\n')

export function validateGseapySmoke(result) {
  const errors = []
  if (result?.version !== EXPECTED_VERSION) {
    errors.push('GSEApy version must be exactly ' + EXPECTED_VERSION)
  }
  if (result?.seed !== EXPECTED_SEED) {
    errors.push('fixed seed differs')
  }
  if (!Array.isArray(result?.runs) || result.runs.length !== 2) {
    return [...errors, 'expected exactly two same-runtime runs']
  }

  for (const [runIndex, run] of result.runs.entries()) {
    if (!Array.isArray(run?.pathways)) {
      errors.push('run ' + (runIndex + 1) + ' pathways must be an array')
      continue
    }
    const names = run.pathways.map(pathway => pathway.name).sort()
    if (
      names.length !== EXPECTED_PATHWAYS.length ||
      names.some((name, index) => name !== EXPECTED_PATHWAYS[index])
    ) {
      errors.push('run ' + (runIndex + 1) + ' pathway names differ')
    }
    for (const pathway of run.pathways) {
      for (const metric of METRICS) {
        if (!Number.isFinite(pathway[metric])) {
          errors.push(
            'run ' +
              (runIndex + 1) +
              ' ' +
              String(pathway.name) +
              ' ' +
              metric +
              ' must be finite'
          )
        }
      }
    }
  }

  if (JSON.stringify(result.runs[0]) !== JSON.stringify(result.runs[1])) {
    errors.push('same-runtime repeats must be deterministic')
  }
  return errors
}

export function runGseapySmoke(python) {
  const result = spawnSync(python, ['-I', '-B', '-c', PYTHON_PROBE], {
    encoding: 'utf8',
    env: {
      HOME: process.env.HOME ?? '',
      PATH: process.env.PATH ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      PYTHONNOUSERSITE: '1',
    },
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error('bundled GSEApy functional smoke failed')
  }
  return JSON.parse(result.stdout.trim())
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--python' || !argv[1]) {
    throw new Error(
      'usage: gseapy-dependency-smoke.mjs --python <bundled-python>'
    )
  }
  return resolve(argv[1])
}

function main() {
  try {
    const python = parseArguments(process.argv.slice(2))
    const errors = validateGseapySmoke(runGseapySmoke(python))
    if (errors.length > 0) {
      process.stdout.write('FAIL\n')
      process.exitCode = 1
      return
    }
    process.stdout.write('PASS\n')
  } catch {
    process.stdout.write('FAIL\n')
    process.exitCode = 1
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main()
}
