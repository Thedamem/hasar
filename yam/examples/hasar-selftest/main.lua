-- Hasar self test
-- Включите пакет в вебе YAM и нажмите «Запустить».
-- Проверяет кольцо, сегментный экран и воспроизведение WAV.
-- Громкость и другие настройки не меняет.

local function has(name)
  return alice.is_available(name)
end

local function sleep_ms(ms)
  alice.sleep(ms)
end

local function set_ring(hex)
  if not has("led") then
    return
  end
  local frame = {}
  for i = 1, device.led_count do
    frame[i] = hex
  end
  alice.set(frame)
end

-- 1. Основные цвета кольца.
if has("led") then
  local colors = { "#FF0000", "#00FF00", "#0000FF", "#FFFFFF" }
  for i = 1, #colors do
    set_ring(colors[i])
    sleep_ms(700)
  end

  -- 2. Каждая зона отдельно: видно, все ли зоны живые.
  for zone = 1, device.led_count do
    local frame = {}
    for i = 1, device.led_count do
      if i == zone then
        frame[i] = "#FFFFFF"
      else
        frame[i] = "#000000"
      end
    end
    alice.set(frame)
    sleep_ms(500)
  end
end

-- 3. Сегментный экран: время и яркость.
if has("clock") then
  alice.clock.time("12:34", 200)
  sleep_ms(2500)
  alice.clock.off()
end

-- 4. Воспроизведение WAV из пакета.
if has("audio") then
  alice.audio.play("tone.wav")
  sleep_ms(3000)
end

-- 5. Вернуть кольцо и экран в штатное состояние.
if has("led") then
  alice.off()
end
if has("clock") then
  alice.clock.off()
end
