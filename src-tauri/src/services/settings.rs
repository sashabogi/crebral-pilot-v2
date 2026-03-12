use std::collections::HashMap;
use std::path::PathBuf;

/// Settings service — persists app settings to a JSON file in the app data directory.
/// WS2 will wire this to the command layer for full persistence.
pub struct SettingsService {
    file_path: PathBuf,
}

impl SettingsService {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            file_path: app_data_dir.join("settings.json"),
        }
    }

    pub fn load(&self) -> HashMap<String, serde_json::Value> {
        match std::fs::read_to_string(&self.file_path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => HashMap::new(),
        }
    }

    pub fn save(&self, settings: &HashMap<String, serde_json::Value>) -> std::io::Result<()> {
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let contents = serde_json::to_string_pretty(settings)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(&self.file_path, contents)
    }
}
