// @LANG:SFC
{
  "pouType": "PROGRAM",
  "pouName": "PRG_SfcCycle",
  "steps": [
    { "id": "S0", "name": "Idle", "initial": true, "action": "OUT_Pump := FALSE; OUT_Valve := FALSE; OUT_Done := FALSE;" },
    { "id": "S1", "name": "Fill", "initial": false, "action": "OUT_Pump := TRUE; OUT_Valve := FALSE; OUT_Done := FALSE;" },
    { "id": "S2", "name": "Done", "initial": false, "action": "OUT_Pump := FALSE; OUT_Valve := TRUE; OUT_Done := TRUE;" }
  ],
  "transitions": [
    { "from": "Idle", "to": "Fill", "cond": "IN_Start AND NOT IN_Fault" },
    { "from": "Fill", "to": "Done", "cond": "IN_Level >= 80.0" },
    { "from": "Done", "to": "Idle", "cond": "IN_Level <= 20.0" }
  ]
}
