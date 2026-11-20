## Fixed · #324 · An update no longer fails when Atlas hangs while quitting: the installer ends a stuck Atlas once its engine has stopped, and otherwise says which step the quit was stuck at

### Details
- On 20 Nov the update to 0.91.0 failed with « Atlas did not quit within 2 minutes »: 0.78.0 had stopped its engine and closed the database, then its process hung in its exit until it was force-quit 6 minutes later.
- After Update the engine writes each step of its stop to `update/quit.log`. If Atlas is still running 10 s after the last step (« engine stopped, database closed »), the installer saves where it was stuck (`update/quit-sample.txt`), ends it and installs.
- If the engine itself never finishes stopping, nothing is ended: the error shown after restart names the step it was at (« stopping agent runs and their commands ») and the processes still running under Atlas.
- Clicking the Dock icon while Atlas is quitting no longer opens a window on the stopping engine.
