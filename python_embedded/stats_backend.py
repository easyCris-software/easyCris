# Compatibility shim — renamed to stats.py in v0.1.25.
# Safe to remove after one release window.
import runpy
import pathlib

runpy.run_path(str(pathlib.Path(__file__).with_name("stats.py")), run_name="__main__")
