const LOCAL_DEVICE_NAME_KEY = "deviceDisplayName";
const LOCAL_DEVICE_ID_KEY = "deviceId";
const USE_THEME_COLORS_KEY = "useThemeColors";

async function load() {
  const { 
    [LOCAL_DEVICE_NAME_KEY]: name, 
    [LOCAL_DEVICE_ID_KEY]: id,
    [USE_THEME_COLORS_KEY]: useThemeColors 
  } = await browser.storage.local.get([
    LOCAL_DEVICE_NAME_KEY,
    LOCAL_DEVICE_ID_KEY,
    USE_THEME_COLORS_KEY
  ]);

  document.getElementById("displayName").value = name || "";
  document.getElementById("deviceIdHint").textContent = id ? `Device id: ${id}` : "";
  // Default to true if not set
  document.getElementById("useThemeColors").checked = useThemeColors !== false;
}

document.getElementById("save").addEventListener("click", async () => {
  const name = document.getElementById("displayName").value.trim();
  const useThemeColors = document.getElementById("useThemeColors").checked;

  await browser.storage.local.set({ 
    [LOCAL_DEVICE_NAME_KEY]: name,
    [USE_THEME_COLORS_KEY]: useThemeColors
  });

  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => {
    status.textContent = "";
  }, 2000);
});

load();
