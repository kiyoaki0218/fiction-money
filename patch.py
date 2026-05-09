import os
import sys
import pygame

file_path = r"c:\Users\maruy\Desktop\その他\geminiCLI\game2\main.py"
with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

story_class_code = '''
# --- ストーリー機能 ---
class StoryManager:
    def __init__(self):
        self.active = False
        self.current_story = []
        self.current_index = 0
        self.viewed_stories = [] # セーブ用
        
        # 画像の読み込み
        try:
            self.bg_office = pygame.image.load(resource_path(os.path.join("assets", "images", "bg_office.png"))).convert()
            self.bg_office = pygame.transform.scale(self.bg_office, (画面の幅, 画面の高さ))
            
            self.chara_assistant = pygame.image.load(resource_path(os.path.join("assets", "images", "chara_assistant.png"))).convert_alpha()
            self.chara_assistant.set_colorkey((255, 255, 255)) # 白背景を透過
            self.chara_assistant = pygame.transform.scale(self.chara_assistant, (int(画面の高さ * 0.8 * self.chara_assistant.get_width() / self.chara_assistant.get_height()), int(画面の高さ * 0.8)))
            
            self.chara_rival = pygame.image.load(resource_path(os.path.join("assets", "images", "chara_rival.png"))).convert_alpha()
            self.chara_rival.set_colorkey((255, 255, 255))
            self.chara_rival = pygame.transform.scale(self.chara_rival, (int(画面の高さ * 0.8 * self.chara_rival.get_width() / self.chara_rival.get_height()), int(画面の高さ * 0.8)))
        except Exception as e:
            print("画像の読み込みに失敗しました:", e)
            self.bg_office = pygame.Surface((画面の幅, 画面の高さ))
            self.chara_assistant = pygame.Surface((200, 400))
            self.chara_rival = pygame.Surface((200, 400))

        self.stories = {
            "prologue": [
                {"bg": self.bg_office, "chara": self.chara_assistant, "text": "社長、起業おめでとうございます！\\n今日から私が社長の秘書を務めさせていただきます。"},
                {"bg": self.bg_office, "chara": self.chara_assistant, "text": "まずは画面をクリックして資金を集めましょう。\\n資金が貯まれば様々な投資が可能になりますよ。"}
            ],
            "milestone_10k": [
                {"bg": self.bg_office, "chara": self.chara_assistant, "text": "社長、所持金が1万円を突破しました！"},
                {"bg": self.bg_office, "chara": self.chara_assistant, "text": "少しずつですが、確実に資産が増えていますね。\\n次は不動産や株の購入も検討してみてはいかがでしょうか。"}
            ],
            "dollar_unlock": [
                {"bg": self.bg_office, "chara": self.chara_assistant, "text": "社長！ ついにドル取引の口座を開設しました！"},
                {"bg": self.bg_office, "chara": self.chara_assistant, "text": "これで為替差益を狙うこともできますね。\\n世界市場への第一歩です！"}
            ],
            "company_acquisition": [
                {"bg": self.bg_office, "chara": self.chara_rival, "text": "フン、まさか我が社の株を全て買い占めるとはな..."},
                {"bg": self.bg_office, "chara": self.chara_assistant, "text": "やりましたね社長！ 株式会社AAAの完全買収に成功しました！"},
                {"bg": self.bg_office, "chara": self.chara_rival, "text": "覚えておけ、ビジネスの世界は甘くない。\\n次は私が貴様を飲み込んでやるからな！"}
            ]
        }

    def trigger_story(self, story_id):
        if story_id not in self.viewed_stories and story_id in self.stories:
            self.active = True
            self.current_story = self.stories[story_id]
            self.current_index = 0
            self.viewed_stories.append(story_id)

    def next_dialogue(self):
        self.current_index += 1
        if self.current_index >= len(self.current_story):
            self.active = False
            
    def draw(self, surface):
        if not self.active: return
        dialogue = self.current_story[self.current_index]
        
        # 背景
        if dialogue.get("bg"):
            surface.blit(dialogue["bg"], (0, 0))
        
        # キャラ
        if dialogue.get("chara"):
            chara_x = 画面の幅 // 2 - dialogue["chara"].get_width() // 2
            chara_y = 画面の高さ - dialogue["chara"].get_height()
            surface.blit(dialogue["chara"], (chara_x, chara_y))
            
        # テキストボックス
        box_height = 200
        box_rect = pygame.Rect(50, 画面の高さ - box_height - 50, 画面の幅 - 100, box_height)
        s = pygame.Surface((box_rect.width, box_rect.height), pygame.SRCALPHA)
        s.fill((0, 0, 0, 200))
        surface.blit(s, (box_rect.x, box_rect.y))
        pygame.draw.rect(surface, (255, 255, 255), box_rect, 3)
        
        # テキスト
        text_lines = dialogue["text"].split('\\n')
        for i, line in enumerate(text_lines):
            text_surf = フォント.render(line, True, (255, 255, 255))
            surface.blit(text_surf, (box_rect.x + 30, box_rect.y + 30 + i * 40))
            
        # クリックナビゲーション
        nav_surf = 小フォント.render("クリックして次へ ▼", True, (200, 200, 200))
        surface.blit(nav_surf, (box_rect.right - 200, box_rect.bottom - 40))
'''

content = content.replace("時計 = pygame.time.Clock()", "時計 = pygame.time.Clock()\n\n" + story_class_code + "\n\nstory_manager = StoryManager()")

story_checks = '''
    # --- ストーリーのトリガーチェック ---
    if "prologue" not in story_manager.viewed_stories:
        story_manager.trigger_story("prologue")
    elif 所持金 >= 10000 and "milestone_10k" not in story_manager.viewed_stories:
        story_manager.trigger_story("milestone_10k")
    elif ドル解放済み and "dollar_unlock" not in story_manager.viewed_stories:
        story_manager.trigger_story("dollar_unlock")
    elif 株式会社AAA_株.is_acquired and "company_acquisition" not in story_manager.viewed_stories:
        story_manager.trigger_story("company_acquisition")

    if story_manager.active:
        # ストーリー中のイベント処理
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                save_game('auto')
                pygame.quit()
                sys.exit()
            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                story_manager.next_dialogue()
        
        # 描画処理
        画面.fill((0, 0, 0))
        story_manager.draw(画面)
        pygame.display.flip()
        時計.tick(60)
        continue  # 通常のゲーム処理をスキップ
'''

content = content.replace("    現在時間 = pygame.time.get_ticks()", story_checks + "\n    現在時間 = pygame.time.get_ticks()")

save_logic_old = '        "銀行利率_分": 銀行利率_分,'
save_logic_new = '        "銀行利率_分": 銀行利率_分,\n        "viewed_stories": story_manager.viewed_stories,'
content = content.replace(save_logic_old, save_logic_new)

load_logic_old = '        銀行利率_分 = game_state.get("銀行利率_分", 0.03)'
load_logic_new = '        銀行利率_分 = game_state.get("銀行利率_分", 0.03)\n        story_manager.viewed_stories = game_state.get("viewed_stories", [])'
content = content.replace(load_logic_old, load_logic_new)

reset_logic_old = '    銀行利率_分 = 0.03'
reset_logic_new = '    銀行利率_分 = 0.03\n    story_manager.viewed_stories = []'
content = content.replace(reset_logic_old, reset_logic_new)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)

print("Patch applied successfully.")
