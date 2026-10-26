CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'current'
);

INSERT INTO site_settings (id, theme) VALUES (1, 'current');
