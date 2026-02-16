1. ~~알림/노티피케이션 센터~~ **DONE** — App badge counts (`app.badge` OS Action + `set_app_badge` MCP tool). Desktop icons show red badge circles with counts. AI sets badges when it knows about new content.
지금은 앱끼리 연결이 없는데, "Recent Papers에 새 논문 5개 도착", "Mersoom에 새 댓글 3개" 같은 알림을 모아주는 센터가 있으면 진짜 OS 느낌이 훨씬 살아요. 상단바 오른쪽에 벨 아이콘 하나면 충분합니다.
2. 파일 매니저 앱 (Finder/탐색기)
Storage가 있긴 한데 데스크톱에서 바로 접근 가능한 시각적 파일 매니저가 있으면 좋겠어요. Excel에서 만든 시트를 저장하고 → Slides에서 불러오는 식의 앱 간 데이터 흐름이 생기면 진정한 OS가 되죠.
3. 터미널/콘솔 앱
AI OS답게 "codex"에 연결된 터미널이 있으면 개발자 사용자에게 킬러 피처가 됩니다. 에이전트한테 채팅으로 시키는 것도 좋지만, 직접 커맨드를 날릴 수 있는 터미널이 있으면 파워유저들이 좋아할 거예요.
4. ~~시계 + 시스템 트레이 (상단/하단 바)~~ **PARTIALLY DONE** — Window variants added: `widget` (chromeless desktop widget) and `panel` (docked full-width bar). AI can now create widgets and panels via `variant` param on `create`/`create_component`.
현재 상단에 "Connected (codex)"만 있는데, 시계, 배터리(가상), Wi-Fi 상태 아이콘, 열린 앱 태스크바 같은 것들이 추가되면 OS 몰입감이 확 올라갑니다.
5. ~~앱 간 드래그 앤 드롭~~ **DONE** — Three gestural interactions: (a) drag app icon onto window, (b) right-click selected text to type instruction for AI, (c) right-click drag to select a region + type instruction. All sent as events to AI.
예를 들어 Recent Papers에서 논문을 드래그해서 Word Lite에 놓으면 자동으로 요약이 생성된다든지, PDF Viewer에서 Slides로 이미지를 끌어오는 식의 앱 간 상호작용이 있으면 정말 미쳤을 것 같아요.
6. 앱 스토어
지금 앱이 고정인데, 사용자가 직접 앱을 설치/삭제하거나, AI에게 "계산기 앱 만들어줘"라고 하면 동적으로 앱이 생성되는 앱 스토어가 있으면 AI OS의 핵심 차별점이 될 수 있어요.
7. 배경화면 커스터마이징
Settings에 이름/언어만 있는데, 배경화면 변경, 테마(다크/라이트/컬러), 아이콘 크기 조절 같은 개인화 옵션이 있으면 사용자들이 "내 OS" 느낌을 받을 수 있어요.
8. ~~위젯 시스템~~ **DONE** — `variant: "widget"` on window create. Chromeless, draggable, stays below standard windows, hover-reveal close button, SE resize grip. AI creates widgets for clocks, notes, etc.
데스크톱 빈 공간에 시계 위젯, 날씨, 할일 목록, 메모 스티커 같은 작은 위젯을 띄울 수 있으면 데스크탑 활용도가 확 올라갑니다.

개인적으로 가장 임팩트 큰 건 6번 앱 스토어라고 생각해요. "AI한테 말하면 앱이 만들어진다"는 컨셉 자체가 이 프로젝트의 가장 큰 무기가 될 수 있거든요. 이미 AI 에이전트 채팅이 있으니 거기서 한 발짝만 더 나가면 됩니다!