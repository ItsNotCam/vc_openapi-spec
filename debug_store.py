import os
os.environ['OLLAMA_URL'] = 'https://ai.home.itsnotcam.dev'
os.environ['OLLAMA_MODEL'] = 'mxbai-embed-large'
os.environ['CHROMA_DB_PATH'] = '/var/lib/openapi-chroma'
from src.store import SpecStore
s = SpecStore()
print(s.list_apis())
