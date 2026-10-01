#!/usr/bin/env bash
# 데모 스택(docker-compose.demo.yaml)에 번들 CSV 를 적재한다. API 키 불필요 —
# DATA_GO_KR_SERVICE_KEY 가 없으면 각 스크립트가 API 적재를 건너뛰고 CSV 만 넣는다.
# 재실행 가능: 매번 스키마를 비우고 처음부터 다시 적재한다(ingest_facilities 가 가장 먼저).
#
# 건너뛰는 것: seed_footprint.py — 온보딩으로 만든 pet_id=1 이 있어야 의미가 있다(없으면 안내만 출력).
set -euo pipefail

cd "$(dirname "$0")/.."
BACKEND=adapdog-demo-backend
DB=adapdog-demo-db
run() { docker exec -w /app "$BACKEND" python "scripts/$@"; }

echo "[1/8] 스키마 초기화 + 시설·정책·무장애 적재"
# ingest_facilities 의 drop_all 은 자기가 import 한 테이블만 알아서, 마이그레이션이 만든 다른 테이블의
# FK(restaurant→region 등)에 막혀 재실행이 실패한다. 그래서 public 스키마를 통째로 비우고 시작한다
# (데모 DB 의 계정·펫 등도 함께 초기화됨).
docker exec "$DB" psql -q -U adapdog -d adapdog -c "drop schema public cascade; create schema public;" 2>/dev/null
run ingest_facilities.py --yes
# facilities 는 7개 테이블만 만들므로, 나머지(account·pet·itinerary 등)는 전체 ORM 메타데이터로 보충하고
# alembic 을 head 로 찍어 두어 backend 재시작 시 `alembic upgrade head` 가 충돌하지 않게 한다.
docker exec -i -w /app "$BACKEND" python - <<'PY'
import sys
sys.path.insert(0, "apps")
import main  # noqa: F401 — 모든 ORM 모델 등록
from sqlalchemy import create_engine
from core.config import DATABASE_URL
from core.database.base import Base
Base.metadata.create_all(create_engine(DATABASE_URL))
PY
docker exec -w /app "$BACKEND" alembic stamp head

echo "[2/8] 견종"
run ingest_breeds.py
echo "[3/8] 음식점"
run ingest_restaurants.py
echo "[4/8] 도시공원"
run ingest_city_parks.py
echo "[5/8] 둘레길"
run ingest_trails.py
echo "[6/8] 동물병원"
run ingest_animal_hospitals.py
echo "[7/8] 닮은친구 시드"
run seed_cohort.py

echo "[8/8] 적재 결과"
docker exec "$DB" psql -U adapdog -d adapdog -c "
select 'region' t, count(*) from region
union all select 'category', count(*) from category
union all select 'facility', count(*) from facility
union all select 'facility(전주)', count(*) from facility f join region r on r.id=f.region_id where r.name like '전주%'
union all select 'breed_catalog', count(*) from breed_catalog
union all select 'restaurant', count(*) from restaurant
union all select 'city_park', count(*) from city_park
union all select 'walking_trail', count(*) from walking_trail
union all select 'animal_hospital', count(*) from animal_hospital
order by 1;"
