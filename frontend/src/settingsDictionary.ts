/**
 * Human-readable Russian labels + grouping for OrcaSlicer's embedded config
 * keys. The reference bridge project never attempted this (verified - it
 * only ever parses a handful of well-known keys like layer_height/filament
 * colour), so this is new: a curated map for the common/meaningful keys,
 * grouped into sections; anything not listed falls back to a humanized
 * version of the raw key name under "Другое" rather than being hidden.
 */

export interface SettingGroup {
  title: string;
  keys: Record<string, string>;
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    title: "Температуры",
    keys: {
      nozzle_temperature: "Сопло",
      nozzle_temperature_initial_layer: "Сопло, первый слой",
      hot_plate_temp: "Стол",
      hot_plate_temp_initial_layer: "Стол, первый слой",
      bed_temperature: "Стол",
      first_layer_temperature: "Сопло, первый слой",
      first_layer_bed_temperature: "Стол, первый слой",
      chamber_temperature: "Камера",
    },
  },
  {
    title: "Слои и стенки",
    keys: {
      layer_height: "Высота слоя",
      initial_layer_print_height: "Высота первого слоя",
      first_layer_height: "Высота первого слоя",
      wall_loops: "Число стенок",
      wall_sequence: "Порядок печати стенок",
      top_shell_layers: "Верхних слоёв",
      bottom_shell_layers: "Нижних слоёв",
      top_shell_thickness: "Толщина верха",
      bottom_shell_thickness: "Толщина низа",
    },
  },
  {
    title: "Заполнение",
    keys: {
      sparse_infill_density: "Плотность заполнения",
      sparse_infill_pattern: "Узор заполнения",
      infill_direction: "Направление заполнения",
      top_surface_pattern: "Узор верхней поверхности",
      bottom_surface_pattern: "Узор нижней поверхности",
    },
  },
  {
    title: "Скорости",
    keys: {
      outer_wall_speed: "Внешняя стенка",
      inner_wall_speed: "Внутренние стенки",
      sparse_infill_speed: "Заполнение",
      internal_solid_infill_speed: "Сплошное заполнение",
      top_surface_speed: "Верхняя поверхность",
      travel_speed: "Перемещения",
      initial_layer_speed: "Первый слой",
      gap_infill_speed: "Заполнение зазоров",
      small_perimeter_speed: "Мелкие периметры",
      support_speed: "Поддержки",
      bridge_speed: "Мосты",
      overhang_speed: "Нависания",
      default_acceleration: "Ускорение (общее)",
      outer_wall_acceleration: "Ускорение внешней стенки",
    },
  },
  {
    title: "Охлаждение",
    keys: {
      fan_min_speed: "Мин. скорость обдува",
      fan_max_speed: "Макс. скорость обдува",
      close_fan_the_first_x_layers: "Обдув выкл. на N слоёв",
      full_fan_speed_layer: "Полный обдув со слоя",
      overhang_fan_speed: "Обдув нависаний",
      slow_down_for_layer_cooling: "Замедление для охлаждения",
      min_layer_time: "Мин. время на слой",
    },
  },
  {
    title: "Ретракт",
    keys: {
      retraction_length: "Длина ретракта",
      retraction_speed: "Скорость ретракта",
      deretraction_speed: "Скорость возврата",
      z_hop: "Подъём Z",
      z_hop_types: "Тип подъёма Z",
      retract_when_changing_layer: "Ретракт при смене слоя",
      retraction_minimum_travel: "Мин. перемещение для ретракта",
    },
  },
  {
    title: "Поддержки и адгезия",
    keys: {
      enable_support: "Поддержки включены",
      support_type: "Тип поддержек",
      support_style: "Стиль поддержек",
      support_threshold_angle: "Порог угла",
      support_base_pattern: "Узор основания",
      support_interface_top_layers: "Слоёв интерфейса сверху",
      support_interface_bottom_layers: "Слоёв интерфейса снизу",
      raft_layers: "Слоёв подложки (raft)",
      support_object_xy_distance: "Отступ от модели (XY)",
      brim_type: "Тип каймы (brim)",
      brim_width: "Ширина каймы",
      brim_separation_gap: "Зазор каймы",
      skirt_loops: "Витков юбки (skirt)",
      skirt_distance: "Отступ юбки",
      elephant_foot_compensation: "Компенсация слоновьей ноги",
    },
  },
  {
    title: "Филамент",
    keys: {
      filament_type: "Тип пластика",
      filament_diameter: "Диаметр прутка",
      filament_density: "Плотность",
      filament_flow_ratio: "Коэффициент потока",
      filament_max_volumetric_speed: "Макс. объёмная скорость",
      nozzle_diameter: "Диаметр сопла",
    },
  },
];

const KNOWN_KEYS = new Map<string, string>();
for (const group of SETTING_GROUPS) {
  for (const [key, label] of Object.entries(group.keys)) {
    KNOWN_KEYS.set(key, label);
  }
}

function humanize(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

export interface DisplaySetting {
  key: string;
  label: string;
  value: string;
}

export interface DisplayGroup {
  title: string;
  items: DisplaySetting[];
}

/** Groups + translates a raw settings dict for display; unmatched keys land in a trailing "Другое" group, humanized rather than hidden. */
export function groupSettings(raw: Record<string, string>): DisplayGroup[] {
  const remaining = new Set(Object.keys(raw));
  const groups: DisplayGroup[] = [];

  for (const group of SETTING_GROUPS) {
    const items: DisplaySetting[] = [];
    for (const key of Object.keys(group.keys)) {
      if (key in raw) {
        items.push({ key, label: group.keys[key], value: raw[key] });
        remaining.delete(key);
      }
    }
    if (items.length > 0) groups.push({ title: group.title, items });
  }

  if (remaining.size > 0) {
    const items = [...remaining]
      .sort((a, b) => a.localeCompare(b))
      .map((key) => ({ key, label: humanize(key), value: raw[key] }));
    groups.push({ title: "Другое", items });
  }

  return groups;
}
