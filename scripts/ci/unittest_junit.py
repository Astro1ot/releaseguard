"""Run `python -m unittest discover -s tests` and also write a JUnit XML report (stdlib only)."""
import sys
import time
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET


class Recorder(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.records = []
        self._started = 0.0

    def startTest(self, test):
        self._started = time.monotonic()
        super().startTest(test)

    def _record(self, test, outcome, detail=''):
        self.records.append((test, outcome, detail, time.monotonic() - self._started))

    def addSuccess(self, test):
        super().addSuccess(test); self._record(test, 'passed')

    def addFailure(self, test, err):
        super().addFailure(test, err); self._record(test, 'failure', self._exc_info_to_string(err, test))

    def addError(self, test, err):
        super().addError(test, err); self._record(test, 'error', self._exc_info_to_string(err, test))

    def addSkip(self, test, reason):
        super().addSkip(test, reason); self._record(test, 'skipped', reason)


def main(output):
    suite = unittest.defaultTestLoader.discover('tests')
    result = unittest.TextTestRunner(verbosity=2, resultclass=Recorder).run(suite)
    root = ET.Element('testsuite', name='python-unittest', tests=str(result.testsRun),
                      failures=str(len(result.failures)), errors=str(len(result.errors)), skipped=str(len(result.skipped)))
    for test, outcome, detail, seconds in result.records:
        case = ET.SubElement(root, 'testcase', classname=type(test).__module__ + '.' + type(test).__name__,
                             name=getattr(test, '_testMethodName', str(test)), time=f'{seconds:.3f}')
        if outcome in ('failure', 'error', 'skipped'):
            ET.SubElement(case, outcome, message=detail.splitlines()[-1] if detail else outcome).text = detail
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(output, encoding='utf-8', xml_declaration=True)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/junit/python.xml'))
