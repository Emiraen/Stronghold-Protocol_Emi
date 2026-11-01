// Generated from the original rogue_2 table; squad powers are not project covenant strategies.
export const MIZUKI_SQUAD_SOURCE = Object.freeze({
  "url": "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/roguelike_topic_table.json",
  "topic": "rogue_2",
  "retrievedAt": "2026-10-27",
  "sha256": "7541a13e7c9670844c0ebcafe5a776ea71a775ac5b57cb4fb10ce718752ca0c9",
  "field": "details.rogue_2.init[].initialBandRelic -> items/relics/bandRef"
});
export const MIZUKI_SQUADS = Object.freeze([
  {
    "id": "rogue_2_band_1",
    "name": "指挥分队",
    "description": "目标生命上限+2，每次战斗结束后额外回复1目标生命",
    "iconId": "rogue_2_band_1",
    "unlockDescription": null,
    "level": 0,
    "effects": [
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_hpmax"
          },
          {
            "key": "count",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "battle_extra_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_hp"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_2",
    "name": "集群分队",
    "description": "可携带干员+2，可同时部署人数+2",
    "iconId": "rogue_2_band_2",
    "unlockDescription": "通过第三层【波涛略地】",
    "level": 0,
    "effects": [
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_squad_capacity"
          },
          {
            "key": "count",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "level_char_limit_add",
        "blackboard": [
          {
            "key": "value",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_3",
    "name": "后勤分队",
    "description": "初始源石锭+20，初始希望+2",
    "iconId": "rogue_2_band_3",
    "unlockDescription": "在多局游戏中累计获得200源石锭",
    "level": 0,
    "effects": [
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_gold"
          },
          {
            "key": "count",
            "value": 20.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_population"
          },
          {
            "key": "count",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_4",
    "name": "矛头分队",
    "description": "目标生命变为1，所有我方单位的攻击力+15%，生命值+15%",
    "iconId": "rogue_2_band_4",
    "unlockDescription": "剩余10点以上目标生命时完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "item_cover_set",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_hp"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "char_attribute_mul",
        "blackboard": [
          {
            "key": "atk",
            "value": 0.15,
            "valueStr": null
          },
          {
            "key": "max_hp",
            "value": 0.15,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_5",
    "name": "突击战术分队",
    "description": "招募和进阶4星以上的【近卫】【先锋】干员时希望降低2点和1点，随机直升概率大幅提升",
    "iconId": "rogue_2_band_5",
    "unlockDescription": "拥有合计至少5名先锋或近卫干员完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "delta",
            "value": -2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.35,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_6",
    "name": "堡垒战术分队",
    "description": "招募和进阶4星以上的【重装】【辅助】干员时希望降低2点和1点，随机直升概率大幅提升",
    "iconId": "rogue_2_band_6",
    "unlockDescription": "拥有合计至少5名重装或辅助干员完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "delta",
            "value": -2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.35,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_7",
    "name": "远程战术分队",
    "description": "招募和进阶4星以上的【医疗】【狙击】干员时希望降低2点和1点，随机直升概率大幅提升",
    "iconId": "rogue_2_band_7",
    "unlockDescription": "拥有合计至少5名医疗或狙击干员完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "delta",
            "value": -2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.35,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_8",
    "name": "破坏战术分队",
    "description": "招募和进阶4星以上的【术师】【特种】干员时希望降低2点和1点，随机直升概率大幅提升",
    "iconId": "rogue_2_band_8",
    "unlockDescription": "拥有合计至少5名特种或术师干员完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "delta",
            "value": -2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.35,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_9",
    "name": "研究分队",
    "description": "初始护盾值+3，战斗获得指挥经验+30%",
    "iconId": "rogue_2_band_9",
    "unlockDescription": "在多局游戏中累计获得1000指挥经验",
    "level": 0,
    "effects": [
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_shield"
          },
          {
            "key": "count",
            "value": 3.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "up_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_exp"
          },
          {
            "key": "up",
            "value": 0.3,
            "valueStr": null
          },
          {
            "key": "mask",
            "value": 0.0,
            "valueStr": "battle"
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_10",
    "name": "高规格分队",
    "description": "初始招募时额外获得1张随机精锐招募券",
    "iconId": "rogue_2_band_10",
    "unlockDescription": "拥有不小于20名干员时完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "initial_recruit_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "pool_init_recruit_random_vip"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_11",
    "name": "心胜于物分队",
    "description": "战斗有概率获得额外收藏品",
    "iconId": "rogue_2_band_11",
    "unlockDescription": null,
    "level": 0,
    "effects": [
      {
        "key": "drop_extra_pool",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "deepsea_1"
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_2"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_15",
    "name": "物尽其用分队",
    "description": "每进入新的一层获得1掷骰次数",
    "iconId": "rogue_2_band_15",
    "unlockDescription": null,
    "level": 0,
    "effects": [
      {
        "key": "zone_into_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_3"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_19",
    "name": "以人为本分队",
    "description": "招募所有干员的希望消耗-1",
    "iconId": "rogue_2_band_19",
    "unlockDescription": null,
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_3,TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR,TANK,SNIPER,CASTER,SUPPORT,MEDIC,SPECIAL"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_5"
          }
        ]
      }
    ]
  }
]);
export const MIZUKI_SQUAD_TIERS = Object.freeze([
  {
    "id": "rogue_2_band_1",
    "name": "指挥分队",
    "description": "目标生命上限+2，每次战斗结束后额外回复1目标生命",
    "iconId": "rogue_2_band_1",
    "unlockDescription": null,
    "level": 0,
    "effects": [
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_hpmax"
          },
          {
            "key": "count",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "battle_extra_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_hp"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_2",
    "name": "集群分队",
    "description": "可携带干员+2，可同时部署人数+2",
    "iconId": "rogue_2_band_2",
    "unlockDescription": "通过第三层【波涛略地】",
    "level": 0,
    "effects": [
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_squad_capacity"
          },
          {
            "key": "count",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "level_char_limit_add",
        "blackboard": [
          {
            "key": "value",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_3",
    "name": "后勤分队",
    "description": "初始源石锭+20，初始希望+2",
    "iconId": "rogue_2_band_3",
    "unlockDescription": "在多局游戏中累计获得200源石锭",
    "level": 0,
    "effects": [
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_gold"
          },
          {
            "key": "count",
            "value": 20.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_population"
          },
          {
            "key": "count",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_4",
    "name": "矛头分队",
    "description": "目标生命变为1，所有我方单位的攻击力+15%，生命值+15%",
    "iconId": "rogue_2_band_4",
    "unlockDescription": "剩余10点以上目标生命时完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "item_cover_set",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_hp"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "char_attribute_mul",
        "blackboard": [
          {
            "key": "atk",
            "value": 0.15,
            "valueStr": null
          },
          {
            "key": "max_hp",
            "value": 0.15,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_5",
    "name": "突击战术分队",
    "description": "招募和进阶4星以上的【近卫】【先锋】干员时希望降低2点和1点，随机直升概率大幅提升",
    "iconId": "rogue_2_band_5",
    "unlockDescription": "拥有合计至少5名先锋或近卫干员完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "delta",
            "value": -2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR"
          },
          {
            "key": "count",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.35,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_6",
    "name": "堡垒战术分队",
    "description": "招募和进阶4星以上的【重装】【辅助】干员时希望降低2点和1点，随机直升概率大幅提升",
    "iconId": "rogue_2_band_6",
    "unlockDescription": "拥有合计至少5名重装或辅助干员完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "delta",
            "value": -2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "TANK,SUPPORT"
          },
          {
            "key": "count",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.35,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_7",
    "name": "远程战术分队",
    "description": "招募和进阶4星以上的【医疗】【狙击】干员时希望降低2点和1点，随机直升概率大幅提升",
    "iconId": "rogue_2_band_7",
    "unlockDescription": "拥有合计至少5名医疗或狙击干员完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "delta",
            "value": -2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "MEDIC,SNIPER"
          },
          {
            "key": "count",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.35,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_8",
    "name": "破坏战术分队",
    "description": "招募和进阶4星以上的【术师】【特种】干员时希望降低2点和1点，随机直升概率大幅提升",
    "iconId": "rogue_2_band_8",
    "unlockDescription": "拥有合计至少5名特种或术师干员完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "delta",
            "value": -2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 4.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 5.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.8,
            "valueStr": null
          }
        ]
      },
      {
        "key": "direct_upgrade",
        "blackboard": [
          {
            "key": "rarity",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "CASTER,SPECIAL"
          },
          {
            "key": "count",
            "value": 6.0,
            "valueStr": null
          },
          {
            "key": "pr",
            "value": 0.35,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_9",
    "name": "研究分队",
    "description": "初始护盾值+3，战斗获得指挥经验+30%",
    "iconId": "rogue_2_band_9",
    "unlockDescription": "在多局游戏中累计获得1000指挥经验",
    "level": 0,
    "effects": [
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_shield"
          },
          {
            "key": "count",
            "value": 3.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "up_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_exp"
          },
          {
            "key": "up",
            "value": 0.3,
            "valueStr": null
          },
          {
            "key": "mask",
            "value": 0.0,
            "valueStr": "battle"
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_10",
    "name": "高规格分队",
    "description": "初始招募时额外获得1张随机精锐招募券",
    "iconId": "rogue_2_band_10",
    "unlockDescription": "拥有不小于20名干员时完成游戏结局",
    "level": 0,
    "effects": [
      {
        "key": "initial_recruit_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "pool_init_recruit_random_vip"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_1"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_11",
    "name": "心胜于物分队",
    "description": "战斗有概率获得额外收藏品",
    "iconId": "rogue_2_band_11",
    "unlockDescription": null,
    "level": 0,
    "effects": [
      {
        "key": "drop_extra_pool",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "deepsea_1"
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_2"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_12",
    "name": "心胜于物分队",
    "description": "战斗有概率获得额外收藏品；完成委托可额外选择一次奖励",
    "iconId": "rogue_2_band_11",
    "unlockDescription": "认知塑造中解锁【感性】",
    "level": 1,
    "effects": [
      {
        "key": "drop_extra_pool",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "deepsea_1"
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_2"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_13",
    "name": "心胜于物分队",
    "description": "战斗有更高概率获得额外收藏品；完成委托可额外选择一次奖励",
    "iconId": "rogue_2_band_11",
    "unlockDescription": "认知塑造中解锁【情绪化】",
    "level": 2,
    "effects": [
      {
        "key": "drop_extra_pool",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "deepsea_2"
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_2"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_14",
    "name": "心胜于物分队",
    "description": "战斗有更高概率获得额外收藏品；完成委托可额外选择一次奖励；初始携带“生还者合约”",
    "iconId": "rogue_2_band_11",
    "unlockDescription": "认知塑造中解锁【物由心生】",
    "level": 3,
    "effects": [
      {
        "key": "drop_extra_pool",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "deepsea_2"
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_2"
          }
        ]
      },
      {
        "key": "immediate_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_relic_fight_158"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_15",
    "name": "物尽其用分队",
    "description": "每进入新的一层获得1掷骰次数",
    "iconId": "rogue_2_band_15",
    "unlockDescription": null,
    "level": 0,
    "effects": [
      {
        "key": "zone_into_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_3"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_16",
    "name": "物尽其用分队",
    "description": "每进入新的一层获得1掷骰次数；初始骰子升级为八面骰子",
    "iconId": "rogue_2_band_15",
    "unlockDescription": "认知塑造中解锁【理性与判断】",
    "level": 1,
    "effects": [
      {
        "key": "zone_into_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice"
          },
          {
            "key": "count",
            "value": 1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_4"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_17",
    "name": "物尽其用分队",
    "description": "每进入新的一层获得2掷骰次数；初始骰子升级为八面骰子",
    "iconId": "rogue_2_band_15",
    "unlockDescription": "认知塑造中解锁【实践】",
    "level": 2,
    "effects": [
      {
        "key": "zone_into_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice"
          },
          {
            "key": "count",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_4"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_18",
    "name": "物尽其用分队",
    "description": "每进入新的一层获得2掷骰次数；初始骰子升级为八面骰子；战斗中可以使用更多骰子",
    "iconId": "rogue_2_band_15",
    "unlockDescription": "认知塑造中解锁【为了生存】",
    "level": 3,
    "effects": [
      {
        "key": "zone_into_reward",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice"
          },
          {
            "key": "count",
            "value": 2.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_4"
          }
        ]
      },
      {
        "key": "battle_dice_up",
        "blackboard": [
          {
            "key": "count",
            "value": 15.0,
            "valueStr": null
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_19",
    "name": "以人为本分队",
    "description": "招募所有干员的希望消耗-1",
    "iconId": "rogue_2_band_19",
    "unlockDescription": null,
    "level": 0,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_3,TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR,TANK,SNIPER,CASTER,SUPPORT,MEDIC,SPECIAL"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_5"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_20",
    "name": "以人为本分队",
    "description": "招募所有干员的希望消耗-1；在“安全的角落”节点可额外选择一次奖励",
    "iconId": "rogue_2_band_19",
    "unlockDescription": "认知塑造中解锁【习惯】",
    "level": 1,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_3,TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR,TANK,SNIPER,CASTER,SUPPORT,MEDIC,SPECIAL"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_5"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_21",
    "name": "以人为本分队",
    "description": "招募和晋升所有干员的希望消耗-1；在“安全的角落”节点可额外选择一次奖励",
    "iconId": "rogue_2_band_19",
    "unlockDescription": "认知塑造中解锁【通识】",
    "level": 2,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_3,TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR,TANK,SNIPER,CASTER,SUPPORT,MEDIC,SPECIAL"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_3,TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR,TANK,SNIPER,CASTER,SUPPORT,MEDIC,SPECIAL"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_5"
          }
        ]
      }
    ]
  },
  {
    "id": "rogue_2_band_22",
    "name": "以人为本分队",
    "description": "招募和晋升所有干员的希望消耗-1；在“安全的角落”节点可额外选择一次奖励；指挥等级上限+1",
    "iconId": "rogue_2_band_19",
    "unlockDescription": "认知塑造中解锁【万众一心】",
    "level": 3,
    "effects": [
      {
        "key": "recruit_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_3,TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR,TANK,SNIPER,CASTER,SUPPORT,MEDIC,SPECIAL"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "upgrade_cost",
        "blackboard": [
          {
            "key": "rarity",
            "value": 0.0,
            "valueStr": "TIER_3,TIER_4,TIER_5,TIER_6"
          },
          {
            "key": "profession",
            "value": 0.0,
            "valueStr": "PIONEER,WARRIOR,TANK,SNIPER,CASTER,SUPPORT,MEDIC,SPECIAL"
          },
          {
            "key": "delta",
            "value": -1.0,
            "valueStr": null
          }
        ]
      },
      {
        "key": "set_dice",
        "blackboard": [
          {
            "key": "id",
            "value": 0.0,
            "valueStr": "rogue_2_dice_5"
          }
        ]
      },
      {
        "key": "level_limitation_up",
        "blackboard": [
          {
            "key": "up",
            "value": 1.0,
            "valueStr": null
          }
        ]
      }
    ]
  }
]);
export const MIZUKI_RECRUIT_GROUPS = Object.freeze([
  {
    "id": "recruit_group_1",
    "iconId": "recruit_group_1",
    "name": "先手必胜",
    "desc": "先锋、狙击、特种招募券各一张",
    "unlockDesc": null
  },
  {
    "id": "recruit_group_2",
    "iconId": "recruit_group_2",
    "name": "稳扎稳打",
    "desc": "重装、术师、狙击招募券各一张",
    "unlockDesc": null
  },
  {
    "id": "recruit_group_3",
    "iconId": "recruit_group_3",
    "name": "取长补短",
    "desc": "近卫、辅助、医疗招募券各一张",
    "unlockDesc": null
  },
  {
    "id": "recruit_group_random",
    "iconId": "recruit_group_random",
    "name": "随心所欲",
    "desc": "三张随机调度券，其中一张为免费六星券；每次出现两名六星干员，可免费刷新三次",
    "unlockDesc": "使用其他招募组合进行一次探索"
  }
]);
