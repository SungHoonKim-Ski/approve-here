-- dmg 볼륨의 Finder 창 배치를 .DS_Store에 적는다. build.sh가 읽기·쓰기 이미지를 마운트한 뒤 호출한다.
-- 좌표는 make-background.swift의 그림과 맞춘다: 창 720×440pt, 아이콘 128pt, 앱 (160,200) · Applications (400,200) · 설치 안내 (610,200).
on run argv
  set vol to POSIX file (item 1 of argv) as alias
  with timeout of 60 seconds
    tell application "Finder"
      open vol
      delay 1
      set w to container window of vol
      set current view of w to icon view
      try
        set toolbar visible of w to false
        set statusbar visible of w to false
        set pathbar visible of w to false
      end try
      set bounds of w to {200, 120, 920, 588}
      set opts to icon view options of w
      set arrangement of opts to not arranged
      set icon size of opts to 128
      set text size of opts to 13
      set background picture of opts to file ".background:background.png" of vol
      set position of item "ApproveHere.app" of vol to {160, 200}
      set position of item "Applications" of vol to {400, 200}
      set position of item "설치 안내.html" of vol to {610, 200}
      -- 창 크기·아이콘 위치는 창을 닫을 때 .DS_Store에 적힌다. 바로 닫으면 빠질 때가 있어 한 박자 둔다.
      set bounds of w to {200, 120, 920, 588}
      update vol without registering applications
      delay 2
      try
        close w
      end try
      delay 1
    end tell
  end timeout
  return "layout ok"
end run
