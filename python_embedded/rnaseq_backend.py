# Compatibility shim — renamed to rnaseq.py in v0.1.25.
# Safe to remove after one release window.
import runpy
import pathlib

runpy.run_path(str(pathlib.Path(__file__).with_name("rnaseq.py")), run_name="__main__")
