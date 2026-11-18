export const profile = {
  "name": "地理目录检索查看器",
  "previewPath": "/csw?service=CSW&request=GetRecords",
  "previewKeys": [
    "matched",
    "returned",
    "nextRecord",
    "records"
  ],
  "capabilitiesPath": "/capabilities",
  "harvest": {
    "hopLimit": 4,
    "maxPages": 10,
    "elementSet": "full"
  }
};
